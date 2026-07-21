import type { FastifyInstance } from 'fastify';
import {
  Server,
  type DefaultEventsMap,
  type RemoteSocket,
  type Socket,
} from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { decodeJwt } from 'jose';
import type { Prisma } from '@prisma/client';
import { config } from './config.js';
import { prisma } from './db.js';
import { AppError } from './errors.js';
import { validateAuthContext } from './auth.js';
import { verifyAccessToken, type AuthContext } from './lib/tokens.js';
import { setRealtimeHub } from './realtime-hub.js';
import {
  getConversationForAuth,
  getParticipant,
  assertDirectConversationLiveAccess,
  messageDto,
  participantTranscriptMessageWhere,
  participantDto,
} from './services/conversations.js';
import { recoverStaleProcessingMessages } from './services/message-processing.js';
import {
  AliyunRealtimeTranslationNotConfiguredError,
  AliyunRealtimeTranslationProtocolError,
  createAliyunRealtimeTranslationSession,
  type AliyunRealtimeTranslationSession,
  type RealtimeTranslationEvent,
  type RealtimeTranslationLanguage,
} from './services/aliyun-realtime-translation.js';
import { friendCallHeartbeatExpiredWhere } from './services/friend-call-liveness.js';

interface SocketData {
  auth: AuthContext;
  tokenExpiresAt: number;
  participantIds: Record<string, string>;
}

type LocalSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
type AuthorizedRemoteSocket = RemoteSocket<DefaultEventsMap, SocketData>;

const MAX_TIMEOUT_MS = 2_147_000_000;
const AUTH_REVALIDATION_INTERVAL_MS = 15_000;
const ROOM_JOIN_RATE_WINDOW_MS = 10_000;
const MAX_ROOM_JOIN_ATTEMPTS_PER_WINDOW = 8;
const CALL_TRANSLATION_AUTH_INTERVAL_MS = 5_000;

interface ActiveCallTranslation {
  key: string;
  callId: string;
  socketId: string;
  sourceSubjectId: string;
  sourceDeviceId: string;
  targetSubjectId: string;
  targetDeviceId: string;
  sourceLanguage: RealtimeTranslationLanguage;
  targetLanguage: RealtimeTranslationLanguage;
  session: AliyunRealtimeTranslationSession;
  lastAuthorizedAt: number;
}

export async function attachRealtime(app: FastifyInstance): Promise<Server> {
  const io = new Server<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    SocketData
  >(app.server, {
      cors: {
        origin: config.CORS_ORIGINS
          ? config.CORS_ORIGINS.split(',').map((value) => value.trim())
          : false,
      },
      transports: ['websocket'],
      maxHttpBufferSize: 100_000,
  });

  const callTranslationSessions = new Map<string, ActiveCallTranslation>();
  const callTranslationStarts = new Set<string>();

  const closeCallTranslation = (key: string, graceful: boolean): void => {
    const active = callTranslationSessions.get(key);
    if (!active) return;
    callTranslationSessions.delete(key);
    if (graceful) void active.session.finish();
    else active.session.abort();
  };

  const closeTranslationsForCall = (callId: string): void => {
    for (const [key, active] of callTranslationSessions) {
      if (active.callId === callId) closeCallTranslation(key, false);
    }
  };

  let redisClients: [Redis, Redis] | undefined;
  let redisReady = !config.REDIS_URL;
  let redisMonitoringEnabled = false;
  if (config.REDIS_URL) {
    redisMonitoringEnabled = true;
    const publisher = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    const subscriber = publisher.duplicate();
    let publisherReady = false;
    let subscriberReady = false;

    const refreshRedisReadiness = () => {
      redisReady = publisherReady && subscriberReady;
    };
    const trackRedisClient = (
      client: Redis,
      name: 'publisher' | 'subscriber',
      setReady: (ready: boolean) => void,
    ) => {
      client.on('ready', () => {
        if (!redisMonitoringEnabled) return;
        setReady(true);
        refreshRedisReadiness();
      });
      for (const event of ['close', 'end', 'reconnecting'] as const) {
        client.on(event, () => {
          if (!redisMonitoringEnabled) return;
          setReady(false);
          refreshRedisReadiness();
          app.log.warn({ redisClient: name, event }, 'Redis realtime client unavailable');
        });
      }
      client.on('error', (error) => {
        if (!redisMonitoringEnabled) return;
        if (client.status !== 'ready') {
          setReady(false);
          refreshRedisReadiness();
        }
        app.log.warn({ error, redisClient: name }, 'Redis realtime client error');
      });
    };

    trackRedisClient(publisher, 'publisher', (ready) => {
      publisherReady = ready;
    });
    trackRedisClient(subscriber, 'subscriber', (ready) => {
      subscriberReady = ready;
    });

    try {
      await Promise.all([publisher.connect(), subscriber.connect()]);
      publisherReady = publisher.status === 'ready';
      subscriberReady = subscriber.status === 'ready';
      refreshRedisReadiness();
      io.adapter(createAdapter(publisher, subscriber));
      redisClients = [publisher, subscriber];
    } catch (error) {
      redisMonitoringEnabled = false;
      publisher.disconnect();
      subscriber.disconnect();
      if (config.NODE_ENV === 'production') throw error;
      redisReady = true;
      app.log.warn({ error }, 'Redis adapter unavailable; using single-instance realtime mode');
    }
  }

  const emitFriendPresence = async (subjectId: string, online: boolean): Promise<void> => {
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ userAId: subjectId }, { userBId: subjectId }] },
      select: { userAId: true, userBId: true },
    });
    for (const friendship of friendships) {
      const friendId = friendship.userAId === subjectId
        ? friendship.userBId
        : friendship.userAId;
      io.to(subjectRoomName(friendId)).emit('friend.presence', { userId: subjectId, online });
    }
  };

  const emitOfflineIfLastSubjectSocket = async (subjectId: string): Promise<void> => {
    const sockets = await io.in(subjectRoomName(subjectId)).fetchSockets();
    if (sockets.length === 0) await emitFriendPresence(subjectId, false);
  };

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') throw new AppError(401, 'UNAUTHORIZED', '缺少登录凭证');
      const auth = await verifyAccessToken(token);
      await validateAuthContext(auth);
      const tokenExpiresAtSeconds = decodeJwt(token).exp;
      const tokenExpiresAt = Number(tokenExpiresAtSeconds) * 1_000;
      if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
        throw new AppError(401, 'TOKEN_INVALID', '登录凭证无效或已过期');
      }
      socket.data.auth = auth;
      socket.data.tokenExpiresAt = tokenExpiresAt;
      socket.data.participantIds = {};
      next();
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(401, 'UNAUTHORIZED', '认证失败');
      const socketError = new Error(appError.message) as Error & { data?: unknown };
      socketError.data = { code: appError.code };
      next(socketError);
    }
  });

  io.on('connection', (socket) => {
    // Socket.IO turns inbound middleware failures into an `error` event. Keep
    // that event handled after sending the structured room.error payload.
    socket.on('error', () => undefined);
    const authRoomsReady = Promise.resolve(
      socket.join([
        subjectRoomName(socket.data.auth.subjectId),
        deviceRoomName(socket.data.auth.subjectId, socket.data.auth.deviceId),
      ]),
    );
    void authRoomsReady.catch((error) => disconnectForAuthError(socket, error));
    void authRoomsReady
      .then(() => emitFriendPresence(socket.data.auth.subjectId, true))
      .catch((error) => {
        app.log.error(
          { error, subjectId: socket.data.auth.subjectId },
          'Friend online presence broadcast failed',
        );
      });
    scheduleTokenExpiry(socket);

    socket.on(
      'friend.call.translation.start',
      async (payload, acknowledge?: (value: unknown) => void) => {
        const callId = String(payload?.callId ?? '');
        const key = `${socket.id}:${callId}`;
        let startGuardKey: string | undefined;
        try {
          if (!callId) throw new AppError(400, 'FRIEND_CALL_ID_REQUIRED', '缺少通话标识');
          closeCallTranslation(key, false);
          const auth = socket.data.auth;
          if (auth.role === 'GUEST') {
            throw new AppError(403, 'FORMAL_ACCOUNT_REQUIRED', '临时用户不能使用好友通话');
          }
          startGuardKey = `${callId}:${auth.subjectId}:${auth.deviceId}`;
          if (callTranslationStarts.has(startGuardKey)) {
            throw new AppError(409, 'REALTIME_TRANSLATION_STARTING', '实时翻译正在连接');
          }
          callTranslationStarts.add(startGuardKey);
          for (const [existingKey, existing] of callTranslationSessions) {
            if (
              existing.callId === callId &&
              existing.sourceSubjectId === auth.subjectId &&
              existing.sourceDeviceId === auth.deviceId
            ) {
              closeCallTranslation(existingKey, false);
            }
          }
          const call = await prisma.friendCall.findFirst({
            where: {
              id: callId,
              status: 'ACTIVE',
              AND: { NOT: friendCallHeartbeatExpiredWhere(new Date()) },
              OR: [
                { callerId: auth.subjectId, callerDeviceId: auth.deviceId },
                { calleeId: auth.subjectId, calleeDeviceId: auth.deviceId },
              ],
            },
            select: {
              callerId: true,
              callerDeviceId: true,
              calleeId: true,
              calleeDeviceId: true,
              caller: { select: { preferredLanguage: true, autoPlayTranslationAudio: true } },
              callee: { select: { preferredLanguage: true, autoPlayTranslationAudio: true } },
            },
          });
          if (!call || !call.calleeDeviceId) {
            throw new AppError(404, 'ACTIVE_FRIEND_CALL_NOT_FOUND', '通话已经结束或已在其他设备接听');
          }
          const callerIsSource = call.callerId === auth.subjectId;
          const sourceLanguage = callLanguage(
            callerIsSource ? call.caller.preferredLanguage : call.callee.preferredLanguage,
          );
          const targetLanguage = callLanguage(
            callerIsSource ? call.callee.preferredLanguage : call.caller.preferredLanguage,
          );
          if (sourceLanguage === targetLanguage) {
            throw new AppError(409, 'CALL_TRANSLATION_SAME_LANGUAGE', '双方语言相同，无需实时翻译');
          }
          const sourceSubjectId = auth.subjectId;
          const sourceDeviceId = auth.deviceId;
          const targetSubjectId = callerIsSource ? call.calleeId : call.callerId;
          const targetDeviceId = callerIsSource ? call.calleeDeviceId : call.callerDeviceId;
          const outputAudio = callerIsSource
            ? call.callee.autoPlayTranslationAudio
            : call.caller.autoPlayTranslationAudio;
          let active: ActiveCallTranslation | undefined;
          const session = await createAliyunRealtimeTranslationSession({
            sourceLanguage,
            targetLanguage,
            outputAudio,
            onEvent: (event) => {
              if (!active || callTranslationSessions.get(key) !== active) return;
              emitCallTranslationEvent(io, active, event, app);
              if (event.type === 'finished' || event.type === 'error') {
                if (event.type === 'error') closeTranslationsForCall(callId);
                else callTranslationSessions.delete(key);
              }
            },
          });
          active = {
            key,
            callId,
            socketId: socket.id,
            sourceSubjectId,
            sourceDeviceId,
            targetSubjectId,
            targetDeviceId,
            sourceLanguage,
            targetLanguage,
            session,
            lastAuthorizedAt: Date.now(),
          };
          callTranslationSessions.set(key, active);
          const response = {
            callId,
            sourceLanguage,
            targetLanguage,
            outputAudio,
          };
          io.to(deviceRoomName(sourceSubjectId, sourceDeviceId))
            .to(deviceRoomName(targetSubjectId, targetDeviceId))
            .emit('friend.call.translation.ready', response);
          acknowledge?.({ ok: true, data: response });
        } catch (error) {
          const translated = callTranslationSocketError(error);
          acknowledge?.({ ok: false, error: translated });
          socket.emit('friend.call.translation.error', { callId, ...translated });
        } finally {
          if (startGuardKey) callTranslationStarts.delete(startGuardKey);
        }
      },
    );

    socket.on('friend.call.translation.audio', async (payload) => {
      const callId = String(payload?.callId ?? '');
      const key = `${socket.id}:${callId}`;
      const active = callTranslationSessions.get(key);
      if (!active) return;
      try {
        if (Date.now() - active.lastAuthorizedAt >= CALL_TRANSLATION_AUTH_INTERVAL_MS) {
          const stillAuthorized = await prisma.friendCall.count({
            where: {
              id: callId,
              status: 'ACTIVE',
              AND: { NOT: friendCallHeartbeatExpiredWhere(new Date()) },
              OR: [
                {
                  callerId: active.sourceSubjectId,
                  callerDeviceId: active.sourceDeviceId,
                },
                {
                  calleeId: active.sourceSubjectId,
                  calleeDeviceId: active.sourceDeviceId,
                },
              ],
            },
          });
          if (stillAuthorized !== 1) {
            throw new AppError(403, 'ACTIVE_FRIEND_CALL_NOT_FOUND', '通话已经结束');
          }
          active.lastAuthorizedAt = Date.now();
        }
        const audio = String(payload?.audio ?? '');
        const sequence = Number(payload?.sequence);
        if (
          audio.length === 0 ||
          audio.length > 20_000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)
        ) {
          throw new AliyunRealtimeTranslationProtocolError('PCM audio payload is invalid');
        }
        active.session.appendAudio(Buffer.from(audio, 'base64'), sequence);
      } catch (error) {
        const translated = callTranslationSocketError(error);
        socket.emit('friend.call.translation.error', { callId, ...translated });
        closeCallTranslation(key, false);
      }
    });

    socket.on('friend.call.translation.finish', (payload) => {
      const callId = String(payload?.callId ?? '');
      closeCallTranslation(`${socket.id}:${callId}`, true);
    });

    // A join performs several authorization and recovery reads. Keep a single
    // socket from multiplying that work with concurrent or tight-loop emits.
    // Reconnects use a new socket and are unaffected by this local guard.
    const roomJoinInFlight = new Set<string>();
    let roomJoinWindowStartedAt = Date.now();
    let roomJoinAttemptsInWindow = 0;

    socket.use(async (packet, next) => {
      try {
        await authRoomsReady;
        // Audio arrives every 100 ms. A full database revocation check per
        // frame would multiply load significantly; token expiry is checked on
        // every frame, while the call/device is revalidated every five seconds
        // and the global auth sweep still revokes sessions within 15 seconds.
        if (packet[0] === 'friend.call.translation.audio') {
          assertSocketTokenFresh(socket.data);
        } else {
          await validateSocketAndJoinedRooms(socket.data, socket.rooms);
        }
        next();
      } catch (error) {
        disconnectForAuthError(socket, error);
        next(socketMiddlewareError(error));
      }
    });

    socket.on('room.join', async (payload, acknowledge?: (value: unknown) => void) => {
      const conversationId = String(payload?.conversationId ?? '');
      const previouslyJoinedParticipantId = socket.data.participantIds[conversationId];
      let ownsJoinAttempt = false;
      try {
        if (!conversationId) {
          throw new AppError(400, 'CONVERSATION_ID_REQUIRED', '缺少会议标识');
        }
        const now = Date.now();
        if (now - roomJoinWindowStartedAt >= ROOM_JOIN_RATE_WINDOW_MS) {
          roomJoinWindowStartedAt = now;
          roomJoinAttemptsInWindow = 0;
        }
        roomJoinAttemptsInWindow += 1;
        if (roomJoinAttemptsInWindow > MAX_ROOM_JOIN_ATTEMPTS_PER_WINDOW) {
          throw new AppError(429, 'ROOM_JOIN_RATE_LIMITED', '入会请求过于频繁，请稍后重试');
        }
        if (roomJoinInFlight.has(conversationId)) {
          throw new AppError(409, 'ROOM_JOIN_IN_PROGRESS', '正在加入该会议');
        }
        roomJoinInFlight.add(conversationId);
        ownsJoinAttempt = true;
        const lastSequence = Math.max(0, Number(payload?.lastSequence ?? 0) || 0);
        const auth = socket.data.auth;
        const conversation = await getConversationForAuth(auth, conversationId, {
          history: true,
        });
        await assertDirectConversationLiveAccess(auth, conversation);
        await assertRealtimeRoomOpen(conversation.id, conversation.status, conversation.expiresAt);
        const participant = await getParticipant(auth, conversationId);
        await recoverStaleProcessingMessages(conversationId);
        await assertSocketAuthorized(socket.data);
        await socket.join(roomName(conversationId));

        let joined;
        try {
          joined = await prisma.$transaction(async (tx) => {
            const snapshot = await lockAndLoadRealtimeJoin(
              tx,
              auth,
              conversationId,
              participant.id,
              lastSequence,
            );
            // Set the mapping while the Conversation/Participant locks are
            // still held. A concurrent REST leave/remove can only commit and
            // call disconnectParticipant after this socket is discoverable.
            socket.data.participantIds[conversationId] = participant.id;
            return snapshot;
          });
          await assertSocketAuthorized(socket.data);
        } catch (error) {
          const mappedParticipantId = socket.data.participantIds[conversationId];
          if (!previouslyJoinedParticipantId) {
            delete socket.data.participantIds[conversationId];
          }
          await socket.leave(roomName(conversationId));
          if (!previouslyJoinedParticipantId && mappedParticipantId) {
            await markParticipantOfflineIfLastSocket(
              io,
              conversationId,
              mappedParticipantId,
              enqueueConversationEmit,
            );
          }
          throw error;
        }
        const response = {
          conversationId,
          participantId: participant.id,
          status: joined.conversation.status,
          latestSequence: joined.missingMessages.reduce(
            (latest, message) => Math.max(latest, message.sequence),
            lastSequence,
          ),
          missingMessages: joined.missingMessages.map(messageDto),
          participants: joined.participants.map(participantDto),
          hasMore: joined.missingMessages.length === 500,
        };
        socket.emit('room.joined', response);
        acknowledge?.({ ok: true, data: response });
        if (!previouslyJoinedParticipantId) {
          enqueueConversationEmit(conversationId, 'participant.joined', {
            conversationId,
            participant: participantDto(joined.joinedParticipant),
          }, socket.id);
        }
      } catch (error) {
        acknowledge?.({ ok: false, error: socketErrorPayload(error) });
        socket.emit('room.error', socketErrorPayload(error));
      } finally {
        if (ownsJoinAttempt) roomJoinInFlight.delete(conversationId);
      }
    });

    socket.on('room.leave', async (payload) => {
      const conversationId = String(payload?.conversationId ?? '');
      if (!conversationId) return;
      const participantId = socket.data.participantIds[conversationId];
      await socket.leave(roomName(conversationId));
      delete socket.data.participantIds[conversationId];
      if (!participantId) return;
      // `room.leave` is a per-socket lifecycle event (the Flutter room page
      // emits it while disposing).  Only REST /leave is a participant-level
      // decision.  Keep another device ONLINE, otherwise mark this member
      // OFFLINE when its last room socket is gone.
      await markParticipantOfflineIfLastSocket(
        io,
        conversationId,
        participantId,
        enqueueConversationEmit,
      ).catch((error) => {
        app.log.error({ error, conversationId, participantId }, 'Realtime leave update failed');
      });
    });

    socket.on('disconnect', () => {
      for (const [key, active] of callTranslationSessions) {
        if (active.socketId === socket.id) closeCallTranslation(key, true);
      }
      for (const [conversationId, participantId] of Object.entries(
        socket.data.participantIds,
      )) {
        void markParticipantOfflineIfLastSocket(
          io,
          conversationId,
          participantId,
          enqueueConversationEmit,
        ).catch((error) => {
          app.log.error(
            { error, conversationId, participantId },
            'Realtime disconnect presence update failed',
          );
        });
      }
      const subjectId = socket.data.auth.subjectId;
      setTimeout(() => {
        void emitOfflineIfLastSubjectSocket(subjectId).catch((error) => {
          app.log.error({ error, subjectId }, 'Friend offline presence broadcast failed');
        });
      }, 0);
    });
  });

  const emitChains = new Map<string, Promise<void>>();
  const subjectEmitChains = new Map<string, Promise<void>>();

  const emitToAuthorizedSockets = async (
    conversationId: string,
    event: string,
    payload: unknown,
    excludedSocketId?: string,
  ): Promise<void> => {
    const sockets = await io.in(roomName(conversationId)).fetchSockets();
    await Promise.all(
      sockets.map(async (socket) => {
        if (socket.id === excludedSocketId) return;
        try {
          await assertSocketAuthorized(socket.data);
          const conversation = await getConversationForAuth(
            socket.data.auth,
            conversationId,
            { history: true },
          );
          await assertDirectConversationLiveAccess(socket.data.auth, conversation);
          await getParticipant(socket.data.auth, conversationId);
          socket.emit(event, payload);
        } catch (error) {
          disconnectForAuthError(socket, error);
        }
      }),
    );
  };

  function enqueueConversationEmit(
    conversationId: string,
    event: string,
    payload: unknown,
    excludedSocketId?: string,
  ): void {
    const previous = emitChains.get(conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => retryRealtimeOperation(
        () => emitToAuthorizedSockets(conversationId, event, payload, excludedSocketId),
      ))
      .catch((error) => {
        app.log.error({ error, conversationId, event }, 'Realtime broadcast failed');
      })
      .finally(() => {
        if (emitChains.get(conversationId) === next) emitChains.delete(conversationId);
      });
    emitChains.set(conversationId, next);
  }

  const emitToAuthorizedSubjectSockets = async (
    subjectId: string,
    event: string,
    payload: unknown,
  ): Promise<void> => {
    const sockets = await io.in(subjectRoomName(subjectId)).fetchSockets();
    await Promise.all(sockets.map(async (socket) => {
      try {
        await assertSocketAuthorized(socket.data);
        socket.emit(event, payload);
      } catch (error) {
        disconnectForAuthError(socket, error);
      }
    }));
  };

  function enqueueSubjectEmit(subjectId: string, event: string, payload: unknown): void {
    const previous = subjectEmitChains.get(subjectId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => retryRealtimeOperation(
        () => emitToAuthorizedSubjectSockets(subjectId, event, payload),
      ))
      .catch((error) => {
        app.log.error({ error, subjectId, event }, 'Realtime subject broadcast failed');
      })
      .finally(() => {
        if (subjectEmitChains.get(subjectId) === next) subjectEmitChains.delete(subjectId);
      });
    subjectEmitChains.set(subjectId, next);
  }

  const authSweep = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      void validateSocketAndJoinedRooms(socket.data, socket.rooms).catch((error) => {
        disconnectForAuthError(socket, error);
      });
    }
  }, AUTH_REVALIDATION_INTERVAL_MS);
  authSweep.unref();

  setRealtimeHub({
    emitToConversation: (conversationId, event, payload) => {
      enqueueConversationEmit(conversationId, event, payload);
    },
    emitToSubject: (subjectId, event, payload) => {
      enqueueSubjectEmit(subjectId, event, payload);
    },
    disconnectDevice: (subjectId, deviceId) => {
      io.in(deviceRoomName(subjectId, deviceId)).disconnectSockets(true);
    },
    disconnectSubject: (subjectId) => {
      io.in(subjectRoomName(subjectId)).disconnectSockets(true);
    },
    disconnectParticipant: async (conversationId, participantId) => {
      try {
        const sockets = await io.in(roomName(conversationId)).fetchSockets();
        let matched = false;
        for (const socket of sockets) {
          if (socket.data.participantIds?.[conversationId] === participantId) {
            matched = true;
            socket.emit('participant.removed', { conversationId, participantId });
            socket.disconnect(true);
          }
        }
        return matched;
      } catch (error) {
        // A Redis adapter outage must not become an unhandled rejection.  The
        // database revocation is already authoritative for every inbound
        // packet; also disconnect any matching local sockets immediately.
        app.log.error(
          { error, conversationId, participantId },
          'Distributed participant disconnect failed; applying local fallback',
        );
        let matched = false;
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.participantIds?.[conversationId] === participantId) {
            matched = true;
            socket.emit('participant.removed', { conversationId, participantId });
            socket.disconnect(true);
          }
        }
        return matched;
      }
    },
    disconnectDirectChatParticipant: async (conversationId, participantId) => {
      try {
        const sockets = await io.in(roomName(conversationId)).fetchSockets();
        let matched = false;
        for (const socket of sockets) {
          if (socket.data.participantIds?.[conversationId] === participantId) {
            matched = true;
            socket.emit('direct.chat.friendship-ended', {
              conversationId,
              participantId,
            });
            socket.disconnect(true);
          }
        }
        return matched;
      } catch (error) {
        app.log.error(
          { error, conversationId, participantId },
          'Distributed direct-chat disconnect failed; applying local fallback',
        );
        let matched = false;
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.participantIds?.[conversationId] === participantId) {
            matched = true;
            socket.emit('direct.chat.friendship-ended', {
              conversationId,
              participantId,
            });
            socket.disconnect(true);
          }
        }
        return matched;
      }
    },
    stopFriendCallTranslation: (callId) => {
      closeTranslationsForCall(callId);
    },
    isSubjectOnline: async (subjectId) => {
      const sockets = await io.in(subjectRoomName(subjectId)).fetchSockets();
      return sockets.length > 0;
    },
    isReady: () => redisReady,
  });

  app.addHook('onClose', async () => {
    redisMonitoringEnabled = false;
    clearInterval(authSweep);
    emitChains.clear();
    subjectEmitChains.clear();
    for (const key of callTranslationSessions.keys()) closeCallTranslation(key, false);
    callTranslationStarts.clear();
    setRealtimeHub({
      emitToConversation: () => undefined,
      emitToSubject: () => undefined,
      disconnectDevice: () => undefined,
      disconnectSubject: () => undefined,
      disconnectParticipant: async () => true,
      disconnectDirectChatParticipant: async () => true,
      stopFriendCallTranslation: () => undefined,
      isSubjectOnline: async () => false,
      isReady: () => true,
    });
    await io.close();
    if (redisClients) await Promise.allSettled(redisClients.map((client) => client.quit()));
  });
  return io;
}

interface LockedRealtimeConversation {
  id: string;
  status: string;
  expiresAt: Date;
  maxSequence: number;
}

interface LockedRealtimeParticipant {
  id: string;
  userId: string | null;
  guestIdentityId: string | null;
  removedAt: Date | null;
  leftAt: Date | null;
  presence: string;
}

interface LockedRealtimeUser {
  id: string;
  status: string;
}

interface LockedRealtimeDevice {
  sessionId: string;
  revokedAt: Date | null;
}

interface LockedRealtimeGuestIdentity {
  id: string;
  sessionId: string;
  deviceId: string;
  conversationId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Linearization point for joining a live room.
 *
 * REST end/leave/remove operations take the Conversation lock before changing
 * membership. Taking the same lock order here prevents a stale preflight read
 * from turning a LEFT/REMOVED participant ONLINE again. All data returned in
 * the join snapshot is also read before releasing those locks.
 */
async function lockAndLoadRealtimeJoin(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  conversationId: string,
  participantId: string,
  lastSequence: number,
) {
  const conversationRows = await tx.$queryRaw<LockedRealtimeConversation[]>`
    SELECT "id", "status", "expiresAt", "maxSequence"
    FROM "Conversation"
    WHERE "id" = ${conversationId}
    FOR UPDATE
  `;
  const conversation = conversationRows[0];
  const now = new Date();
  if (
    !conversation ||
    !['WAITING', 'ACTIVE'].includes(conversation.status) ||
    conversation.expiresAt <= now
  ) {
    throw new AppError(403, 'ROOM_EXPIRED', '房间已结束或过期');
  }

  // Match the lifecycle write lock order used by account deletion, logout and
  // final message commits: Conversation -> identity/session -> Participant.
  // This makes a revoke that commits first authoritative without introducing
  // Participant/identity lock inversions.
  if (auth.role === 'GUEST') {
    const guestIdentityId = auth.guestIdentityId ?? auth.subjectId;
    const guestRows = await tx.$queryRaw<LockedRealtimeGuestIdentity[]>`
      SELECT "id", "sessionId", "deviceId", "conversationId", "expiresAt", "revokedAt"
      FROM "GuestIdentity"
      WHERE "id" = ${guestIdentityId}
      FOR UPDATE
    `;
    const guest = guestRows[0];
    if (
      !guest ||
      guest.revokedAt ||
      guest.expiresAt <= now ||
      guest.conversationId !== conversationId ||
      guest.deviceId !== auth.deviceId ||
      !auth.sessionId ||
      guest.sessionId !== auth.sessionId
    ) {
      throw new AppError(401, 'GUEST_TOKEN_REVOKED', '访客身份已失效');
    }
  } else {
    const userRows = await tx.$queryRaw<LockedRealtimeUser[]>`
      SELECT "id", "status"
      FROM "User"
      WHERE "id" = ${auth.subjectId}
      FOR UPDATE
    `;
    if (!userRows[0] || userRows[0].status !== 'ACTIVE') {
      throw new AppError(401, 'ACCOUNT_DISABLED', '账号不存在或已停用');
    }
    const deviceRows = await tx.$queryRaw<LockedRealtimeDevice[]>`
      SELECT "sessionId", "revokedAt"
      FROM "UserDevice"
      WHERE "userId" = ${auth.subjectId} AND "deviceId" = ${auth.deviceId}
      FOR UPDATE
    `;
    const device = deviceRows[0];
    if (
      !device ||
      device.revokedAt ||
      !auth.sessionId ||
      device.sessionId !== auth.sessionId
    ) {
      throw new AppError(401, 'DEVICE_REVOKED', '此设备登录已被撤销');
    }
  }

  const participantRows = await tx.$queryRaw<LockedRealtimeParticipant[]>`
    SELECT "id", "userId", "guestIdentityId", "removedAt", "leftAt", "presence"
    FROM "Participant"
    WHERE "id" = ${participantId} AND "conversationId" = ${conversationId}
    FOR UPDATE
  `;
  const participant = participantRows[0];
  const expectedGuestIdentityId = auth.guestIdentityId ?? auth.subjectId;
  const identityMatches = auth.role === 'GUEST'
    ? participant?.guestIdentityId === expectedGuestIdentityId
    : participant?.userId === auth.subjectId;
  if (
    !participant ||
    !identityMatches ||
    participant.removedAt ||
    participant.leftAt ||
    !['ONLINE', 'OFFLINE'].includes(participant.presence)
  ) {
    throw new AppError(403, 'NOT_A_PARTICIPANT', '您不是该会议参与者');
  }

  const touched = await tx.participant.updateMany({
    where: {
      id: participantId,
      conversationId,
      removedAt: null,
      leftAt: null,
      presence: { in: ['ONLINE', 'OFFLINE'] },
    },
    data: { lastSeenAt: now, presence: 'ONLINE' },
  });
  if (touched.count !== 1) {
    throw new AppError(403, 'NOT_A_PARTICIPANT', '您不是该会议参与者');
  }

  const missingMessages = await tx.translationMessage.findMany({
    where: {
      ...participantTranscriptMessageWhere,
      conversationId,
      sequence: { gt: lastSequence },
    },
    orderBy: { sequence: 'asc' },
    take: 500,
  });
  const participants = await tx.participant.findMany({
    where: { conversationId },
    orderBy: { joinedAt: 'asc' },
  });
  const joinedParticipant = await tx.participant.findUniqueOrThrow({
    where: { id: participantId },
  });
  return { conversation, missingMessages, participants, joinedParticipant };
}

async function assertRealtimeRoomOpen(
  conversationId: string,
  status: string,
  expiresAt: Date,
): Promise<void> {
  const now = new Date();
  if (status === 'WAITING' || status === 'ACTIVE') {
    if (expiresAt > now) return;
    await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        status: { in: ['WAITING', 'ACTIVE'] },
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
  }
  throw new AppError(403, 'ROOM_EXPIRED', '房间已结束或过期');
}

function emitCallTranslationEvent(
  io: Server,
  active: ActiveCallTranslation,
  event: RealtimeTranslationEvent,
  app: FastifyInstance,
): void {
  if (event.type === 'translation.audio') {
    io.to(deviceRoomName(active.targetSubjectId, active.targetDeviceId)).emit(
      'friend.call.translation.audio',
      {
        callId: active.callId,
        speakerId: active.sourceSubjectId,
        audio: event.audio,
        sampleRate: event.sampleRate,
      },
    );
    return;
  }
  if (event.type === 'error') {
    app.log.warn(
      { callId: active.callId, code: event.code },
      'Friend call realtime translation failed',
    );
    io.to(deviceRoomName(active.sourceSubjectId, active.sourceDeviceId))
      .to(deviceRoomName(active.targetSubjectId, active.targetDeviceId))
      .emit('friend.call.translation.error', {
        callId: active.callId,
        code: 'REALTIME_TRANSLATION_FAILED',
        message: '实时翻译服务暂时不可用，已恢复原声通话',
      });
    return;
  }
  if (event.type === 'finished') {
    io.to(deviceRoomName(active.sourceSubjectId, active.sourceDeviceId))
      .to(deviceRoomName(active.targetSubjectId, active.targetDeviceId))
      .emit('friend.call.translation.finished', { callId: active.callId });
    return;
  }
  io.to(deviceRoomName(active.sourceSubjectId, active.sourceDeviceId))
    .to(deviceRoomName(active.targetSubjectId, active.targetDeviceId))
    .emit('friend.call.translation.text', {
      callId: active.callId,
      speakerId: active.sourceSubjectId,
      kind: event.type,
      text: event.text,
      language: event.language,
    });
}

function callLanguage(value: string): RealtimeTranslationLanguage {
  return value.toLowerCase() === 'ru' ? 'ru' : 'zh';
}

function callTranslationSocketError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof AliyunRealtimeTranslationNotConfiguredError) {
    return { code: 'REALTIME_TRANSLATION_NOT_CONFIGURED', message: '实时翻译服务尚未配置' };
  }
  return { code: 'REALTIME_TRANSLATION_FAILED', message: '实时翻译服务暂时不可用，已恢复原声通话' };
}

const roomName = (conversationId: string) => `conversation:${conversationId}`;
const roomSegment = (value: string) => Buffer.from(value).toString('base64url');
const subjectRoomName = (subjectId: string) => `auth:subject:${roomSegment(subjectId)}`;
const deviceRoomName = (subjectId: string, deviceId: string) =>
  `auth:device:${roomSegment(subjectId)}:${roomSegment(deviceId)}`;

async function assertSocketAuthorized(data: SocketData): Promise<void> {
  assertSocketTokenFresh(data);
  await validateAuthContext(data.auth);
}

function assertSocketTokenFresh(data: SocketData): void {
  if (!data.auth || !Number.isFinite(data.tokenExpiresAt) || data.tokenExpiresAt <= Date.now()) {
    throw new AppError(401, 'TOKEN_INVALID', '登录凭证无效或已过期');
  }
}

export async function validateSocketAndJoinedRooms(
  data: SocketData,
  rooms: Iterable<string>,
): Promise<void> {
  await assertSocketAuthorized(data);
  for (const room of rooms) {
    if (!room.startsWith('conversation:')) continue;
    const conversationId = room.slice('conversation:'.length);
    if (!conversationId) continue;
    const conversation = await getConversationForAuth(data.auth, conversationId, {
      history: true,
    });
    await assertDirectConversationLiveAccess(data.auth, conversation);
    await assertRealtimeRoomOpen(
      conversation.id,
      conversation.status,
      conversation.expiresAt,
    );
    // Historical visibility is intentionally broader than live-room access.
    // A LEFT participant may still read permitted history over HTTP, but must
    // not retain a realtime subscription or receive future broadcasts.
    await getParticipant(data.auth, conversationId);
  }
}

async function markParticipantOfflineIfLastSocket(
  io: Server,
  conversationId: string,
  participantId: string,
  emit: (conversationId: string, event: string, payload: unknown) => void,
): Promise<void> {
  const sockets = await io.in(roomName(conversationId)).fetchSockets();
  if (
    sockets.some(
      (socket) => socket.data.participantIds?.[conversationId] === participantId,
    )
  ) {
    return;
  }
  const updated = await prisma.participant.updateMany({
    where: {
      id: participantId,
      conversationId,
      removedAt: null,
      leftAt: null,
      presence: 'ONLINE',
    },
    data: { presence: 'OFFLINE', lastSeenAt: new Date() },
  });
  if (updated.count !== 1) return;
  const participant = await prisma.participant.findUnique({
    where: { id: participantId },
  });
  if (!participant) return;
  emit(conversationId, 'participant.presence', {
    conversationId,
    participant: participantDto(participant),
  });
}

function scheduleTokenExpiry(socket: LocalSocket): void {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const remaining = socket.data.tokenExpiresAt - Date.now();
    if (remaining <= 0) {
      disconnectForAuthError(
        socket,
        new AppError(401, 'TOKEN_INVALID', '登录凭证无效或已过期'),
      );
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_MS));
    timer.unref();
  };
  arm();
  socket.once('disconnect', () => {
    if (timer) clearTimeout(timer);
  });
}

function disconnectForAuthError(
  socket: LocalSocket | AuthorizedRemoteSocket,
  error: unknown,
): void {
  socket.emit('room.error', socketErrorPayload(error));
  socket.disconnect(true);
}

function socketMiddlewareError(error: unknown): Error {
  const payload = socketErrorPayload(error);
  const socketError = new Error(payload.message) as Error & { data?: unknown };
  socketError.data = { code: payload.code };
  return socketError;
}

function socketErrorPayload(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: '实时房间操作失败' };
}

async function retryRealtimeOperation(
  operation: () => Promise<void>,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
