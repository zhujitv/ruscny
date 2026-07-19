(() => {
  'use strict';

  const translations = {
    zh: {
      documentTitle: '中俄实时翻译会议',
      productName: '中俄实时翻译', interfaceLanguage: '界面语言',
      guestMeeting: '临时参会', joinTitle: '无需安装，直接加入会议',
      joinLead: '填写参会资料后，即可查看实时原文、译文和发言人。',
      featureRealtime: '中俄双向实时翻译', featureIdentity: '每段内容都标明发言人',
      featureReconnect: '断线后自动重连和补拉', inviteDetected: '已识别会议邀请',
      roomCode: '房间码', roomCodePlaceholder: '6–8 位数字', displayName: '姓名或显示名称',
      namePlaceholder: '例如：王经理 / Ivan', company: '所属公司',
      companyPlaceholder: '请填写本次参会使用的公司名称', speechLanguage: '本次发言语言',
      email: '接收会议纪要的邮箱', emailPlaceholder: 'name@company.com',
      emailHint: '主持人可在会议结束后向此邮箱发送会议纪要。',
      chinese: '中文', russian: '俄语', speechLanguageHint: '发言时请使用选定语言，系统会自动翻译为另一种语言。',
      joinNow: '立即进入会议', openApp: '已安装 App？在 App 中打开',
      privacyNote: '参会资料用于本次会议身份、发言归属和主持人发放会议纪要。邀请凭证和访问凭证只保留在当前浏览器会话中。',
      connecting: '正在连接…', connected: '已连接', reconnecting: '网络中断，正在重连…',
      meeting: '翻译会议', participants: '参会者', exportTxt: '导出 TXT', leaveMeeting: '退出会议',
      liveTranscript: '实时会议内容', waitingForSpeech: '等待发言', latest: '最新内容',
      noMessages: '还没有发言内容', noMessagesHint: '按住下方按钮说话，松开后自动提交翻译。',
      holdToTalk: '按住说话，松开提交', retryUpload: '重试上传',
      microphoneNotice: '首次使用时，浏览器会请求麦克风权限。', returnToJoin: '返回加入页',
      joining: '正在验证身份并加入…', synced: '已同步至第 {sequence} 条', syncing: '正在补拉缺失消息…',
      syncFailed: '记录补拉失败，请检查网络后重试连接',
      online: '在线', offline: '离线', left: '已离开', removed: '已移出', me: '我', host: '主持人',
      original: '原文', translation: '译文', processing: '翻译中', final: '已翻译', failed: '失败',
      reviewPending: '待确认', reviewConfirmed: '已确认', reviewRejected: '已拒绝',
      translatingSpeaker: '{name} 正在发言或翻译…', processingHint: '语音识别与翻译中…',
      translationFailed: '本段翻译失败', playTranslation: '播放译文', playing: '正在播放…', ttsUnavailable: '译文语音暂不可用',
      recording: '正在录音，松开提交', uploading: '正在上传并翻译…', uploadFailed: '上传失败，可使用同一条录音重试',
      recordingTooShort: '录音时间太短，请重试', microphoneDenied: '无法使用麦克风，请在浏览器设置中允许权限',
      recorderUnsupported: '当前浏览器不支持语音录制，请使用最新版 Chrome 或 Safari',
      confirmLeave: '确定退出本次会议吗？', meetingEnded: '会议已结束', endedReadOnly: '会议已结束，当前内容仅可查看，不能继续发言。',
      participantRemovedTitle: '您已被移出会议', participantRemovedMessage: '服务端已立即撤销您的查看和发言权限。',
      roomUnavailableTitle: '无法进入会议', roomUnavailableMessage: '会议可能已结束、过期，或邀请已更新。请联系主持人。',
      leftTitle: '已退出会议', leftMessage: '您已离开本次会议，当前设备已停止接收会议内容。',
      requiredFields: '请完整填写姓名、公司、邮箱和发言语言', invalidEmail: '请输入有效邮箱', invalidRoomCode: '请输入 6–8 位数字房间码',
      requestFailed: '请求失败，请稍后重试', realtimeUnavailable: '实时通信组件未加载，请刷新页面',
      exported: '会议记录已导出', networkOffline: '当前设备已断网',
    },
    ru: {
      documentTitle: 'Китайско-русская онлайн-встреча',
      productName: 'Перевод китайский ⇄ русский', interfaceLanguage: 'Язык интерфейса',
      guestMeeting: 'Гостевое участие', joinTitle: 'Войдите во встречу без установки',
      joinLead: 'Заполните данные участника, чтобы видеть исходный текст, перевод и автора каждой реплики.',
      featureRealtime: 'Перевод в обе стороны', featureIdentity: 'Имя автора у каждой реплики',
      featureReconnect: 'Автоматическое переподключение', inviteDetected: 'Приглашение распознано',
      roomCode: 'Код комнаты', roomCodePlaceholder: '6–8 цифр', displayName: 'Имя',
      namePlaceholder: 'Например: Ivan', company: 'Компания', companyPlaceholder: 'Укажите компанию',
      email: 'Email для протокола', emailPlaceholder: 'name@company.com',
      emailHint: 'После встречи ведущий сможет отправить протокол на этот адрес.',
      speechLanguage: 'Язык вашей речи', chinese: 'Китайский', russian: 'Русский',
      speechLanguageHint: 'Говорите на выбранном языке. Система переведёт речь на другой язык.',
      joinNow: 'Войти во встречу', openApp: 'Открыть в приложении',
      privacyNote: 'Данные используются для идентификации, авторства реплик и отправки протокола ведущим. Ключи хранятся только в текущей сессии браузера.',
      connecting: 'Подключение…', connected: 'Подключено', reconnecting: 'Связь прервана. Переподключение…',
      meeting: 'Встреча с переводом', participants: 'Участники', exportTxt: 'Экспорт TXT', leaveMeeting: 'Выйти',
      liveTranscript: 'Текст встречи', waitingForSpeech: 'Ожидание речи', latest: 'К новым',
      noMessages: 'Пока нет реплик', noMessagesHint: 'Удерживайте кнопку во время речи и отпустите для отправки.',
      holdToTalk: 'Удерживайте, чтобы говорить', retryUpload: 'Повторить',
      microphoneNotice: 'При первом запуске браузер запросит доступ к микрофону.', returnToJoin: 'На страницу входа',
      joining: 'Проверка и вход…', synced: 'Синхронизировано до №{sequence}', syncing: 'Загрузка пропущенных сообщений…',
      syncFailed: 'Не удалось загрузить запись. Проверьте сеть и повторите подключение',
      online: 'В сети', offline: 'Не в сети', left: 'Ушёл', removed: 'Удалён', me: 'я', host: 'Ведущий',
      original: 'Оригинал', translation: 'Перевод', processing: 'Переводится', final: 'Готово', failed: 'Ошибка',
      reviewPending: 'Ожидает подтверждения', reviewConfirmed: 'Подтверждено', reviewRejected: 'Отклонено',
      translatingSpeaker: '{name} говорит или переводится…', processingHint: 'Распознавание и перевод…',
      translationFailed: 'Не удалось перевести эту реплику', playTranslation: 'Слушать перевод', playing: 'Воспроизведение…', ttsUnavailable: 'Аудиоперевод недоступен',
      recording: 'Запись. Отпустите для отправки', uploading: 'Отправка и перевод…', uploadFailed: 'Ошибка отправки. Можно повторить с той же записью',
      recordingTooShort: 'Запись слишком короткая', microphoneDenied: 'Нет доступа к микрофону. Разрешите его в настройках браузера',
      recorderUnsupported: 'Браузер не поддерживает запись. Используйте новую версию Chrome или Safari',
      confirmLeave: 'Выйти из этой встречи?', meetingEnded: 'Встреча завершена', endedReadOnly: 'Встреча завершена. Текст доступен только для чтения.',
      participantRemovedTitle: 'Вас удалили из встречи', participantRemovedMessage: 'Сервер немедленно отозвал доступ к чтению и микрофону.',
      roomUnavailableTitle: 'Встреча недоступна', roomUnavailableMessage: 'Встреча завершена, истекла или приглашение обновлено. Свяжитесь с ведущим.',
      leftTitle: 'Вы вышли из встречи', leftMessage: 'Это устройство больше не получает сообщения встречи.',
      requiredFields: 'Заполните имя, компанию, email и язык', invalidEmail: 'Введите корректный email', invalidRoomCode: 'Введите код из 6–8 цифр',
      requestFailed: 'Ошибка запроса. Попробуйте позже', realtimeUnavailable: 'Модуль связи не загружен. Обновите страницу',
      exported: 'Файл встречи экспортирован', networkOffline: 'Устройство не в сети',
    },
  };

  const dom = Object.fromEntries([
    'locale-select', 'join-view', 'room-view', 'terminal-view', 'guest-form', 'join-button',
    'join-error', 'room-code-group', 'room-code', 'display-name', 'company', 'email', 'speech-language',
    'invite-badge', 'open-app', 'connection-dot', 'connection-label', 'meeting-title', 'meeting-meta',
    'participants-list', 'participant-count', 'participants-toggle', 'participants-panel',
    'transcript', 'empty-transcript', 'sync-label', 'scroll-latest', 'active-speaker',
    'active-speaker-label', 'record-button', 'record-label', 'recording-time', 'composer-message',
    'retry-upload', 'leave-button', 'export-txt', 'terminal-title', 'terminal-message',
    'return-button', 'toast',
  ].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));

  const keys = {
    locale: 'tooyei.webGuest.locale.v1',
    device: 'tooyei.webGuest.device.v1',
    invitation: 'tooyei.webGuest.invitation.v1',
    session: 'tooyei.webGuest.session.v1',
    principal: 'tooyei.webGuest.principal.v1',
  };

  const state = {
    locale: sessionGet(keys.locale) || (navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'zh'),
    deviceId: sessionGet(keys.device) || makeId('web-device'),
    invitation: readJson(keys.invitation) || {},
    session: readJson(keys.session),
    sessionGeneration: 0,
    principalToken: sessionGet(keys.principal),
    conversation: null,
    participantId: null,
    participants: new Map(),
    messages: new Map(),
    messageElements: new Map(),
    socket: null,
    socketRenewAttempts: 0,
    syncPromise: null,
    renewPromise: null,
    terminal: false,
    ended: false,
    recorder: null,
    recordingStartPromise: null,
    recordingGeneration: 0,
    recordingContext: null,
    mediaStream: null,
    recordingChunks: [],
    recordingStartedAt: 0,
    recordingTimer: null,
    autoStopTimer: null,
    pointerPressed: false,
    stopAfterStart: false,
    suppressClick: false,
    uploading: false,
    pendingUpload: null,
    uploadGeneration: 0,
    uploadAbortController: null,
    currentAudio: null,
    audioRequestButton: null,
    audioGeneration: 0,
    toastTimer: null,
  };

  sessionSet(keys.device, state.deviceId);
  captureInvitationFromPath();
  bindUi();
  applyLocale(state.locale);
  restoreSession();

  function t(key, values = {}) {
    let value = translations[state.locale]?.[key] || translations.zh[key] || key;
    for (const [name, replacement] of Object.entries(values)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  function sessionGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (_) { return null; }
  }

  function sessionSet(key, value) {
    try {
      if (value == null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch (_) { /* Private mode can disable storage; the live page still works. */ }
  }

  function readJson(key) {
    try { return JSON.parse(sessionGet(key) || 'null'); } catch (_) { return null; }
  }

  function writeJson(key, value) {
    sessionSet(key, value == null ? null : JSON.stringify(value));
  }

  function makeId(prefix) {
    const suffix = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${suffix}`;
  }

  function captureInvitationFromPath() {
    const match = window.location.pathname.match(/^\/join\/([A-Za-z0-9_-]{16,256})\/?$/);
    if (match) {
      const changed = Boolean(
        state.session && state.invitation.roomToken !== match[1],
      );
      state.invitation = { roomToken: match[1] };
      writeJson(keys.invitation, state.invitation);
      if (changed) clearAuthSession();
      window.history.replaceState(null, '', '/join');
    }
  }

  function bindUi() {
    dom.locale_select.addEventListener('change', () => applyLocale(dom.locale_select.value));
    dom.speech_language.addEventListener('change', () => { dom.speech_language.dataset.touched = 'true'; });
    dom.guest_form.addEventListener('submit', joinAsGuest);
    dom.open_app.addEventListener('click', openNativeApp);
    dom.leave_button.addEventListener('click', leaveMeeting);
    dom.export_txt.addEventListener('click', () => exportTranscript());
    dom.return_button.addEventListener('click', returnToJoin);
    dom.retry_upload.addEventListener('click', () => state.pendingUpload && uploadRecording(state.pendingUpload));
    dom.scroll_latest.addEventListener('click', scrollToLatest);
    dom.participants_toggle.addEventListener('click', toggleParticipants);
    dom.transcript.addEventListener('scroll', updateLatestButton, { passive: true });
    bindRecorderButton();
    window.addEventListener('online', () => state.socket?.connect());
    window.addEventListener('offline', () => setConnection('offline', t('networkOffline')));
    window.addEventListener('pagehide', () => {
      cancelRecording();
      stopCurrentAudio();
      if (state.socket?.connected && state.session?.conversationId) {
        state.socket.emit('room.leave', { conversationId: state.session.conversationId });
      }
    });
  }

  function applyLocale(locale) {
    stopCurrentAudio();
    state.locale = locale === 'ru' ? 'ru' : 'zh';
    sessionSet(keys.locale, state.locale);
    document.documentElement.lang = state.locale === 'ru' ? 'ru' : 'zh-CN';
    document.title = t('documentTitle');
    dom.locale_select.value = state.locale;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
      element.placeholder = t(element.dataset.i18nPlaceholder);
    }
    if (!state.session && !dom.speech_language.dataset.touched) dom.speech_language.value = state.locale;
    renderParticipants();
    rerenderMessages();
    refreshRoomLabels();
  }

  function showOnly(view) {
    document.body.classList.toggle('room-active', view === 'room');
    dom.join_view.hidden = view !== 'join';
    dom.room_view.hidden = view !== 'room';
    dom.terminal_view.hidden = view !== 'terminal';
  }

  async function restoreSession() {
    const profile = state.session?.profile;
    if (profile) {
      dom.display_name.value = profile.displayName || '';
      dom.company.value = profile.company || '';
      dom.email.value = profile.email || '';
      dom.speech_language.value = profile.preferredLanguage || state.locale;
    }
    refreshInvitationUi();
    if (!state.session?.accessToken || !state.session?.conversationId) {
      showOnly('join');
      return;
    }
    showOnly('room');
    setConnection('offline', t('connecting'));
    try {
      const conversation = await loadConversation();
      if (conversation.status === 'ENDED') {
        await markMeetingEnded();
        return;
      }
      if (conversation.status === 'EXPIRED') throw apiError('ROOM_EXPIRED');
      connectRealtime();
    } catch (error) {
      handleRoomError(error);
    }
  }

  function refreshInvitationUi() {
    const hasToken = Boolean(state.invitation.roomToken);
    dom.invite_badge.hidden = !hasToken;
    dom.open_app.hidden = !hasToken;
    dom.room_code_group.hidden = hasToken;
    if (state.invitation.roomCode) dom.room_code.value = state.invitation.roomCode;
  }

  async function joinAsGuest(event) {
    event.preventDefault();
    dom.join_error.hidden = true;
    const profile = {
      displayName: dom.display_name.value.trim(),
      company: dom.company.value.trim(),
      email: dom.email.value.trim().toLowerCase(),
      preferredLanguage: dom.speech_language.value === 'ru' ? 'ru' : 'zh',
    };
    const roomCode = dom.room_code.value.replace(/\s/g, '');
    if (!profile.displayName || !profile.company || !profile.email) {
      showJoinError(t('requiredFields'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      showJoinError(t('invalidEmail'));
      return;
    }
    if (!state.invitation.roomToken && !/^\d{6,8}$/.test(roomCode)) {
      showJoinError(t('invalidRoomCode'));
      return;
    }
    // A retained recording belongs to the room/profile that created it. A
    // fresh join must never be able to retry that blob against another room.
    clearPendingUpload();
    invalidateRecordingStart();
    stopCurrentAudio();
    state.socket?.disconnect();
    state.participantId = null;
    state.invitation = state.invitation.roomToken ? state.invitation : { roomCode };
    writeJson(keys.invitation, state.invitation);
    dom.join_button.disabled = true;
    dom.join_button.querySelector('span').textContent = t('joining');
    try {
      const baseBody = {
        ...profile,
        deviceId: state.deviceId,
        ...(state.invitation.roomToken ? { inviteToken: state.invitation.roomToken } : {}),
        ...(state.invitation.roomCode ? { roomCode: state.invitation.roomCode } : {}),
      };
      let response;
      try {
        response = await jsonRequest('/v1/auth/guest', {
          method: 'POST',
          body: { ...baseBody, ...(state.principalToken ? { guestPrincipalToken: state.principalToken } : {}) },
          auth: false,
        });
      } catch (error) {
        if (error.code !== 'GUEST_PRINCIPAL_INVALID') throw error;
        state.principalToken = null;
        sessionSet(keys.principal, null);
        response = await jsonRequest('/v1/auth/guest', { method: 'POST', body: baseBody, auth: false });
      }
      state.principalToken = response.guestPrincipalToken;
      sessionSet(keys.principal, state.principalToken);
      state.session = {
        accessToken: response.accessToken,
        conversationId: response.conversationId,
        guestIdentityId: response.guestIdentityId,
        profile,
      };
      state.sessionGeneration += 1;
      writeJson(keys.session, state.session);
      state.terminal = false;
      state.ended = false;
      state.messages.clear();
      state.messageElements.clear();
      state.participants.clear();
      dom.transcript.querySelectorAll('.message-card').forEach((element) => element.remove());
      showOnly('room');
      await loadConversation();
      connectRealtime();
    } catch (error) {
      showOnly('join');
      showJoinError(errorMessage(error));
    } finally {
      dom.join_button.disabled = false;
      dom.join_button.querySelector('span').textContent = t('joinNow');
    }
  }

  async function jsonRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.auth !== false && state.session?.accessToken) {
      headers.set('Authorization', `Bearer ${state.session.accessToken}`);
    }
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (_) {
      throw apiError('NETWORK_ERROR');
    }
    let payload;
    try { payload = await response.json(); } catch (_) { payload = null; }
    if (!response.ok || payload?.ok !== true) {
      const error = apiError(payload?.code || `HTTP_${response.status}`, payload?.message);
      error.status = response.status;
      if (
        response.status === 401 &&
        !options.renewed &&
        options.auth !== false &&
        ['TOKEN_INVALID', 'GUEST_TOKEN_REVOKED', 'UNAUTHORIZED'].includes(error.code)
      ) {
        await renewGuestAccess();
        return jsonRequest(path, { ...options, renewed: true });
      }
      throw error;
    }
    return payload.data;
  }

  async function renewGuestAccess() {
    if (state.renewPromise) return state.renewPromise;
    if (!state.principalToken || !state.session?.conversationId || !state.deviceId) {
      throw apiError('GUEST_REFRESH_INVALID');
    }
    const renewalSession = state.session;
    const renewalGeneration = state.sessionGeneration;
    state.renewPromise = (async () => {
      let response;
      try {
        response = await fetch('/v1/auth/guest/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guestPrincipalToken: state.principalToken,
            conversationId: renewalSession.conversationId,
            deviceId: state.deviceId,
          }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
      } catch (_) {
        throw apiError('NETWORK_ERROR');
      }
      let payload;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok || payload?.ok !== true || !payload.data?.accessToken) {
        const error = apiError(payload?.code || 'GUEST_REFRESH_INVALID', payload?.message);
        error.status = response.status;
        throw error;
      }
      if (
        renewalGeneration !== state.sessionGeneration ||
        state.session !== renewalSession
      ) {
        throw apiError('SESSION_CHANGED');
      }
      state.session = {
        ...renewalSession,
        accessToken: payload.data.accessToken,
        guestIdentityId: payload.data.guestIdentityId || state.session.guestIdentityId,
        profile: {
          displayName: payload.data.displayName || renewalSession.profile.displayName,
          company: payload.data.company || renewalSession.profile.company,
          preferredLanguage: payload.data.preferredLanguage || renewalSession.profile.preferredLanguage,
        },
      };
      writeJson(keys.session, state.session);
      if (state.socket) {
        state.socket.auth = { token: state.session.accessToken };
        // /auth/guest/refresh revokes the previous scoped socket. The server
        // may deliver that disconnect just before or just after this response;
        // the disconnect handler below performs the matching manual connect.
        if (!state.socket.connected && !state.terminal && !state.ended) {
          state.socket.connect();
        }
      }
      return state.session.accessToken;
    })().finally(() => { state.renewPromise = null; });
    return state.renewPromise;
  }

  function apiError(code, message) {
    const error = new Error(message || code || 'REQUEST_FAILED');
    error.code = code || 'REQUEST_FAILED';
    return error;
  }

  async function loadConversation() {
    const data = await jsonRequest(`/v1/conversations/${encodeURIComponent(state.session.conversationId)}`);
    state.conversation = data.conversation;
    dom.meeting_title.textContent = state.conversation.title || t('meeting');
    const contact = [state.conversation.contactName, state.conversation.company].filter(Boolean).join(' · ');
    dom.meeting_meta.textContent = contact;
    mergeParticipants(state.conversation.participants || []);
    return state.conversation;
  }

  async function refreshParticipants() {
    const data = await jsonRequest(
      `/v1/conversations/${encodeURIComponent(state.session.conversationId)}/participants`,
    );
    mergeParticipants(data.items || []);
  }

  function connectRealtime() {
    if (typeof window.io !== 'function') {
      handleRoomError(apiError('REALTIME_UNAVAILABLE'));
      return;
    }
    state.socket?.disconnect();
    setConnection('offline', t('connecting'));
    const socket = window.io({
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token: state.session.accessToken },
      reconnection: true,
      reconnectionDelay: 700,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.35,
    });
    state.socket = socket;
    socket.on('connect', () => {
      joinRealtimeRoom(socket);
    });
    socket.on('room.joined', handleRoomJoined);
    socket.on('participant.joined', (payload) => mergeParticipants([payload?.participant]));
    socket.on('participant.updated', (payload) => mergeParticipants([payload?.participant]));
    socket.on('participant.presence', (payload) => mergeParticipants([payload?.participant]));
    socket.on('participant.removed', handleParticipantRemoved);
    socket.on('translation.processing', (message) => mergeMessage(message));
    socket.on('translation.final', (message) => mergeMessage(message));
    socket.on('translation.failed', (message) => mergeMessage(message));
    socket.on('translation.review.updated', (message) => mergeMessage(message));
    socket.on('room.ended', () => { void markMeetingEnded(); });
    socket.on('room.error', handleRoomError);
    socket.on('connect_error', (rawError) => {
      const error = normalizeSocketError(rawError);
      if (error.code === 'GUEST_TOKEN_REVOKED') {
        // A refresh rotates the server-side session before its HTTP response
        // reaches this page. If a reconnect with the old token loses that
        // race, wait for the in-flight renewal instead of terminalizing a
        // still-valid meeting.
        if (state.renewPromise) {
          reconnectAfterGuestRenewal(socket);
          return;
        }
        handleRoomError(error);
        return;
      }
      if (['TOKEN_INVALID', 'UNAUTHORIZED'].includes(error.code)) {
        recoverRealtimeAuthentication(socket);
        return;
      }
      handleRoomError(error);
    });
    socket.on('disconnect', (reason) => {
      if (state.terminal || state.ended || socket !== state.socket) return;
      cancelRecording();
      dom.record_button.disabled = true;
      setConnection('offline', t('reconnecting'));
      // Socket.IO deliberately disables automatic reconnection after
      // `io server disconnect`. Guest REST refresh uses exactly that path to
      // evict sockets authenticated by the old token, so reconnect manually
      // with the latest token. A removed participant will be rejected by the
      // authoritative room.join and then handled as terminal.
      if (reason === 'io server disconnect') {
        reconnectAfterGuestRenewal(socket);
      }
    });
  }

  function reconnectAfterGuestRenewal(socket) {
    const renewal = state.renewPromise ?? Promise.resolve();
    void renewal
      .then(() => {
        if (socket === state.socket && !socket.connected && !state.terminal && !state.ended) {
          socket.auth = { token: state.session?.accessToken };
          socket.connect();
        }
      })
      .catch(handleRoomError);
  }

  function recoverRealtimeAuthentication(socket = state.socket) {
    if (!socket || socket !== state.socket || state.terminal || state.ended) return;
    if (state.socketRenewAttempts >= 1) {
      handleRoomError(apiError('GUEST_REFRESH_INVALID'));
      return;
    }
    state.socketRenewAttempts += 1;
    void renewGuestAccess()
      .then(() => {
        if (socket === state.socket && !state.terminal && !state.ended) {
          socket.auth = { token: state.session.accessToken };
          if (!socket.connected) socket.connect();
          else joinRealtimeRoom(socket);
        }
      })
      .catch(handleRoomError);
  }

  function joinRealtimeRoom(socket) {
    if (socket !== state.socket || state.terminal || state.ended) return;
    setConnection('online', t('connecting'));
    const payload = {
      conversationId: state.session.conversationId,
      lastSequence: contiguousCommittedSequence(),
    };
    socket.emit('room.join', payload, (acknowledgement) => {
      if (acknowledgement?.ok) handleRoomJoined(acknowledgement.data);
      else if (acknowledgement?.error) handleRoomError(acknowledgement.error);
    });
  }

  function handleRoomJoined(payload) {
    if (!payload || payload.conversationId !== state.session?.conversationId || state.terminal) return;
    state.participantId = payload.participantId;
    state.socketRenewAttempts = 0;
    setConnection('online', t('connected'));
    dom.record_button.disabled = (payload.status || state.conversation?.status) !== 'ACTIVE';
    mergeParticipants(payload.participants || []);
    const batch = payload.missingMessages || [];
    mergeMessages(batch, true);
    if (payload.hasMore) {
      const cursor = batch.reduce((max, message) => Math.max(max, Number(message.sequence) || 0), 0);
      void pullAllMessages(cursor);
    } else {
      refreshSyncLabel();
    }
  }

  async function pullAllMessages(afterSequence) {
    if (state.syncPromise) return state.syncPromise;
    const conversationId = state.session?.conversationId;
    if (!conversationId) return;
    state.syncPromise = (async () => {
      dom.sync_label.textContent = t('syncing');
      let cursor = Math.max(0, Number(afterSequence) || 0);
      while (!state.terminal && state.session?.conversationId === conversationId) {
        const data = await retryMessagePage(() => jsonRequest(
          `/v1/conversations/${encodeURIComponent(conversationId)}/messages?afterSequence=${cursor}&limit=500`,
        ));
        if (state.session?.conversationId !== conversationId) return;
        const items = data.items || [];
        mergeMessages(items, true);
        if (items.length === 0) break;
        const next = items.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), cursor);
        if (next <= cursor || items.length < 500) break;
        cursor = next;
      }
      refreshSyncLabel();
      scrollToLatest();
    })().catch((error) => {
      dom.sync_label.textContent = t('syncFailed');
      handleRoomError(error);
    }).finally(() => { state.syncPromise = null; });
    return state.syncPromise;
  }

  async function retryMessagePage(operation) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (isTerminalError(error) || attempt === 3) break;
        await delay(350 * (2 ** attempt));
      }
    }
    throw lastError || apiError('REQUEST_FAILED');
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function contiguousCommittedSequence() {
    const committed = new Set();
    for (const message of state.messages.values()) {
      if (message.status === 'FINAL' || message.status === 'FAILED') committed.add(Number(message.sequence));
    }
    let sequence = 0;
    while (committed.has(sequence + 1)) sequence += 1;
    return sequence;
  }

  function mergeParticipants(items) {
    for (const participant of items) {
      if (!participant) continue;
      const id = participant.participantId || participant.id;
      if (!id) continue;
      state.participants.set(id, { ...(state.participants.get(id) || {}), ...participant, id });
    }
    renderParticipants();
  }

  function renderParticipants() {
    if (!dom.participants_list) return;
    const participants = [...state.participants.values()].sort((left, right) =>
      String(left.joinedAt || '').localeCompare(String(right.joinedAt || '')),
    );
    dom.participants_list.replaceChildren();
    dom.participant_count.textContent = String(participants.filter((item) => item.presence !== 'REMOVED').length);
    for (const participant of participants) {
      const row = element('div', `participant-row${participant.id === state.participantId ? ' me' : ''}`);
      const avatar = element('span', 'participant-avatar', initialFor(participant.displayName));
      const copy = element('span', 'participant-copy');
      const displayName = participant.id === state.participantId
        ? `${participant.displayName} (${t('me')})`
        : participant.displayName;
      copy.append(
        element('strong', '', displayName || '—'),
        element('span', '', [participant.company, participant.preferredLanguage === 'ru' ? t('russian') : t('chinese')].filter(Boolean).join(' · ')),
      );
      const presenceValue = String(participant.presence || 'OFFLINE').toLowerCase();
      const presence = element('span', `presence ${presenceValue}`);
      presence.title = t(presenceValue) || presenceValue;
      row.append(avatar, copy, presence);
      dom.participants_list.append(row);
    }
  }

  function mergeMessages(messages, bulk = false) {
    for (const message of messages) mergeMessage(message, bulk);
    if (bulk) {
      updateEmptyTranscript();
      refreshActiveSpeaker();
    }
  }

  function mergeMessage(message, bulk = false) {
    if (!message || message.conversationId !== state.session?.conversationId) return;
    const id = message.messageId || message.id;
    if (!id) return;
    const current = state.messages.get(id);
    if (messageStatusRank(current?.status) > messageStatusRank(message.status)) return;
    const currentRevision = Number(current?.reviewRevision) || 0;
    const incomingRevision = Number(message.reviewRevision) || 0;
    if (currentRevision > incomingRevision) return;
    if (
      currentRevision === incomingRevision &&
      reviewStatusRank(current?.reviewStatus) > reviewStatusRank(message.reviewStatus)
    ) return;
    const merged = { ...(current || {}), ...message, id, messageId: id };
    state.messages.set(id, merged);
    renderMessage(merged, bulk);
    updateEmptyTranscript();
    refreshActiveSpeaker();
    refreshSyncLabel();
  }

  function reviewStatusRank(value) {
    if (value === 'CONFIRMED' || value === 'REJECTED') return 2;
    if (value === 'PENDING') return 1;
    return 0;
  }

  function messageStatusRank(value) {
    if (value === 'FINAL') return 2;
    if (value === 'FAILED') return 1;
    return 0;
  }

  function rerenderMessages() {
    if (!dom.transcript) return;
    for (const message of sortedMessages()) renderMessage(message, true);
    updateEmptyTranscript();
    refreshActiveSpeaker();
  }

  function sortedMessages() {
    return [...state.messages.values()].sort((left, right) =>
      (Number(left.sequence) || Number.MAX_SAFE_INTEGER) - (Number(right.sequence) || Number.MAX_SAFE_INTEGER) ||
      String(left.createdAt || '').localeCompare(String(right.createdAt || '')),
    );
  }

  function renderMessage(message, bulk) {
    const wasNearBottom = isNearBottom();
    let card = state.messageElements.get(message.id);
    if (!card) {
      card = element('article', 'message-card');
      card.dataset.messageId = message.id;
      state.messageElements.set(message.id, card);
    }
    const status = String(message.status || 'PROCESSING').toUpperCase();
    card.className = `message-card ${status.toLowerCase()}`;
    card.replaceChildren();

    const header = element('div', 'message-head');
    const speakerLine = element('div', 'speaker-line');
    const speakerCopy = element('div', 'speaker-copy');
    const speakerName = message.speakerDisplayName || message.speakerName || '—';
    speakerCopy.append(
      element('strong', '', speakerName),
      element('span', '', [message.speakerCompany, languageName(message.speakerLanguage)].filter(Boolean).join(' · ')),
    );
    speakerLine.append(element('span', 'speaker-initial', initialFor(speakerName)), speakerCopy);
    const reviewLabel = message.reviewStatus === 'PENDING'
      ? t('reviewPending')
      : message.reviewStatus === 'CONFIRMED'
        ? t('reviewConfirmed')
        : message.reviewStatus === 'REJECTED'
          ? t('reviewRejected')
          : null;
    const statusLabel = reviewLabel || (status === 'FINAL' ? t('final') : status === 'FAILED' ? t('failed') : t('processing'));
    const sequence = Number(message.sequence) > 0 ? `#${message.sequence} · ` : '';
    header.append(speakerLine, element('span', `message-status ${status.toLowerCase()}`, `${sequence}${statusLabel}`));
    card.append(header);

    const body = element('div', 'message-body');
    const source = element('div', 'message-text');
    source.append(
      element('div', 'language-label', `${t('original')} · ${languageName(message.sourceLanguage)}`),
      element('p', status === 'PROCESSING' ? 'processing-placeholder' : '',
        status === 'PROCESSING' ? t('processingHint') : (message.sourceText || t('translationFailed'))),
    );
    const translated = element('div', 'message-text translation-copy');
    translated.append(
      element('div', 'language-label', `${t('translation')} · ${languageName(message.targetLanguage)}`),
      element('p', status === 'PROCESSING' ? 'processing-placeholder' : '',
        status === 'PROCESSING' ? t('processingHint') : (message.translatedText || t('translationFailed'))),
    );
    body.append(source, translated);
    card.append(body);

    const footer = element('div', 'message-foot');
    footer.append(element('time', 'message-time', formatTime(message.createdAt)));
    if (status === 'FINAL' && message.audioUrl) {
      const play = element('button', 'audio-button', t('playTranslation'));
      play.type = 'button';
      play.addEventListener('click', () => playTts(message, play));
      footer.append(play);
    } else if (status === 'FAILED' || message.errorCode) {
      footer.append(element('span', 'error-detail', message.errorCode === 'TTS_FAILED'
        ? t('ttsUnavailable')
        : errorMessage({ code: message.errorCode, message: message.errorMessage })));
    }
    card.append(footer);

    if (!card.isConnected) {
      const ordered = sortedMessages();
      const index = ordered.findIndex((item) => item.id === message.id);
      const next = ordered.slice(index + 1).map((item) => state.messageElements.get(item.id)).find((item) => item?.isConnected);
      dom.transcript.insertBefore(card, next || null);
    }
    if (!bulk && wasNearBottom) scrollToLatest();
    else updateLatestButton();
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function initialFor(value) {
    return String(value || '?').trim().slice(0, 1).toUpperCase();
  }

  function languageName(value) {
    return value === 'ru' ? t('russian') : value === 'zh' ? t('chinese') : String(value || '');
  }

  function formatTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(state.locale === 'ru' ? 'ru-RU' : 'zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date);
  }

  function updateEmptyTranscript() {
    dom.empty_transcript.hidden = state.messages.size > 0;
  }

  function refreshActiveSpeaker() {
    const processing = sortedMessages().filter((message) => message.status === 'PROCESSING').at(-1);
    dom.active_speaker.hidden = !processing;
    if (processing) {
      dom.active_speaker_label.textContent = t('translatingSpeaker', {
        name: processing.speakerDisplayName || processing.speakerName || '—',
      });
    }
  }

  function refreshSyncLabel() {
    if (!dom.sync_label || state.syncPromise) return;
    const latest = sortedMessages().reduce((max, message) => Math.max(max, Number(message.sequence) || 0), 0);
    dom.sync_label.textContent = latest ? t('synced', { sequence: latest }) : t('waitingForSpeech');
  }

  function refreshRoomLabels() {
    if (!state.session) return;
    if (state.ended) {
      setConnection('error', t('meetingEnded'));
      dom.composer_message.textContent = t('endedReadOnly');
      dom.record_label.textContent = t('meetingEnded');
    }
    refreshSyncLabel();
  }

  function isNearBottom() {
    return dom.transcript.scrollHeight - dom.transcript.scrollTop - dom.transcript.clientHeight < 120;
  }

  function updateLatestButton() {
    dom.scroll_latest.hidden = isNearBottom();
  }

  function scrollToLatest() {
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
    dom.scroll_latest.hidden = true;
  }

  function setConnection(kind, label) {
    dom.connection_dot.className = `connection-dot ${kind === 'online' ? '' : kind}`.trim();
    dom.connection_label.textContent = label;
  }

  function toggleParticipants() {
    const open = !dom.participants_panel.classList.contains('open');
    dom.participants_panel.classList.toggle('open', open);
    dom.participants_toggle.setAttribute('aria-expanded', String(open));
  }

  function bindRecorderButton() {
    dom.record_button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      state.pointerPressed = true;
      state.stopAfterStart = false;
      dom.record_button.setPointerCapture?.(event.pointerId);
      void startRecording(true);
    });
    const release = (event) => {
      if (!state.pointerPressed) return;
      event.preventDefault();
      state.pointerPressed = false;
      state.stopAfterStart = true;
      state.suppressClick = true;
      if (state.recorder?.state === 'recording') stopRecording();
      window.setTimeout(() => { state.suppressClick = false; }, 350);
    };
    dom.record_button.addEventListener('pointerup', release);
    dom.record_button.addEventListener('pointercancel', release);
    dom.record_button.addEventListener('lostpointercapture', () => {
      if (state.pointerPressed) {
        state.pointerPressed = false;
        state.stopAfterStart = true;
        if (state.recorder?.state === 'recording') stopRecording();
      }
    });
    dom.record_button.addEventListener('click', (event) => {
      if (state.suppressClick) {
        event.preventDefault();
        return;
      }
      if (state.recorder?.state === 'recording') stopRecording();
      else void startRecording(false);
    });
  }

  function startRecording(fromPointer) {
    if (
      state.terminal || state.ended || state.uploading ||
      !state.socket?.connected || !state.participantId ||
      state.recorder?.state === 'recording'
    ) return Promise.resolve();
    if (state.recordingStartPromise) {
      if (!fromPointer) invalidateRecordingStart();
      return state.recordingStartPromise;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function') {
      showToast(t('recorderUnsupported'));
      return Promise.resolve();
    }
    const format = supportedRecordingFormat();
    if (!format) {
      showToast(t('recorderUnsupported'));
      return Promise.resolve();
    }
    const generation = ++state.recordingGeneration;
    const startPromise = startRecordingAttempt(fromPointer, format, generation)
      .finally(() => {
        if (state.recordingStartPromise === startPromise) state.recordingStartPromise = null;
      });
    state.recordingStartPromise = startPromise;
    return startPromise;
  }

  async function startRecordingAttempt(fromPointer, format, generation) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (
        generation !== state.recordingGeneration || state.terminal || state.ended ||
        (fromPointer && !state.pointerPressed && state.stopAfterStart)
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: format.mimeType });
      const context = {
        recorder,
        stream,
        chunks: [],
        startedAt: Date.now(),
        format,
        cancelled: false,
      };
      state.recordingContext = context;
      state.mediaStream = stream;
      state.recordingChunks = context.chunks;
      state.recordingStartedAt = context.startedAt;
      state.recorder = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (!context.cancelled && event.data?.size) context.chunks.push(event.data);
      });
      recorder.addEventListener('error', () => {
        cancelRecording(context);
        showToast(t('requestFailed'));
      });
      recorder.addEventListener('stop', () => finishRecording(context));
      recorder.start(250);
      if (generation !== state.recordingGeneration || state.recordingContext !== context) {
        cancelRecording(context);
        return;
      }
      setRecordingUi(true);
      state.recordingTimer = window.setInterval(updateRecordingClock, 250);
      state.autoStopTimer = window.setTimeout(() => stopRecording(), 45_000);
    } catch (_) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === state.recordingGeneration) {
        cancelRecording();
        if (!state.terminal && !state.ended) showToast(t('microphoneDenied'));
      }
    }
  }

  function invalidateRecordingStart() {
    state.recordingGeneration += 1;
    state.pointerPressed = false;
    state.stopAfterStart = true;
  }

  function supportedRecordingFormat() {
    const choices = [
      ['audio/mp4', 'm4a'],
      ['audio/webm;codecs=opus', 'webm'],
      ['audio/webm', 'webm'],
      ['audio/ogg;codecs=opus', 'ogg'],
      ['audio/ogg', 'ogg'],
    ];
    for (const [mimeType, extension] of choices) {
      if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, extension };
    }
    return null;
  }

  function stopRecording() {
    if (state.recordingContext?.recorder.state === 'recording') {
      state.recordingContext.recorder.stop();
    }
  }

  function cancelRecording(target = state.recordingContext) {
    if (!target || target === state.recordingContext) invalidateRecordingStart();
    if (target) {
      target.cancelled = true;
      target.chunks.length = 0;
      if (target.recorder.state === 'recording') {
        try { target.recorder.stop(); } catch (_) { /* already stopped */ }
      }
    }
    cleanupRecorder(target);
    setRecordingUi(false);
  }

  function cleanupRecorder(target = state.recordingContext) {
    target?.stream.getTracks().forEach((track) => track.stop());
    if (!target || state.recordingContext === target) {
      window.clearInterval(state.recordingTimer);
      window.clearTimeout(state.autoStopTimer);
      state.recordingTimer = null;
      state.autoStopTimer = null;
      state.mediaStream = null;
      state.recorder = null;
      state.recordingContext = null;
    }
  }

  function finishRecording(context) {
    const duration = Date.now() - context.startedAt;
    const chunks = [...context.chunks];
    context.chunks.length = 0;
    cleanupRecorder(context);
    setRecordingUi(false);
    if (context.cancelled || state.terminal || state.ended) return;
    if (duration < 350 || chunks.length === 0) {
      showToast(t('recordingTooShort'));
      return;
    }
    const blob = new Blob(chunks, { type: context.format.mimeType });
    if (blob.size === 0 || blob.size > 6_000_000) {
      showToast(t('uploadFailed'));
      return;
    }
    const upload = {
      blob,
      mimeType: context.format.mimeType,
      extension: context.format.extension,
      idempotencyKey: makeId('web-audio'),
      conversationId: state.session?.conversationId,
      participantId: state.participantId,
      guestIdentityId: state.session?.guestIdentityId,
      sourceLanguage: state.session?.profile?.preferredLanguage,
    };
    if (!upload.conversationId || !upload.participantId || !upload.sourceLanguage) {
      showToast(t('uploadFailed'));
      return;
    }
    state.pendingUpload = upload;
    void uploadRecording(upload);
  }

  function updateRecordingClock() {
    const seconds = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
    dom.recording_time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function setRecordingUi(recording) {
    dom.record_button.classList.toggle('recording', recording);
    dom.record_button.closest('.composer').classList.toggle('recording', recording);
    dom.record_label.textContent = recording ? t('recording') : t('holdToTalk');
    dom.composer_message.textContent = recording ? t('recording') : t('holdToTalk');
    if (!recording) dom.recording_time.textContent = '00:00';
  }

  async function uploadRecording(upload) {
    if (state.uploading || state.terminal || state.ended) return;
    if (!uploadMatchesCurrentSession(upload)) {
      if (state.pendingUpload === upload) clearPendingUpload();
      return;
    }
    const generation = ++state.uploadGeneration;
    const abortController = new AbortController();
    state.uploadAbortController = abortController;
    state.uploading = true;
    dom.retry_upload.hidden = true;
    dom.record_button.disabled = true;
    dom.record_button.classList.add('uploading');
    dom.record_label.textContent = t('uploading');
    dom.composer_message.textContent = t('uploading');
    const form = new FormData();
    const sourceLanguage = upload.sourceLanguage;
    form.append('sourceLanguage', sourceLanguage);
    form.append('targetLanguage', sourceLanguage === 'zh' ? 'ru' : 'zh');
    form.append('audio', upload.blob, `speech.${upload.extension}`);
    let retryAfterRenew = false;
    try {
      const response = await fetch(
        `/v1/conversations/${encodeURIComponent(upload.conversationId)}/audio`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${state.session.accessToken}`,
            'Idempotency-Key': upload.idempotencyKey,
          },
          body: form,
          signal: abortController.signal,
          cache: 'no-store',
          credentials: 'same-origin',
        },
      );
      let payload;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok || payload?.ok !== true) {
        const error = apiError(payload?.code || `HTTP_${response.status}`, payload?.message);
        error.status = response.status;
        throw error;
      }
      if (generation !== state.uploadGeneration || !uploadMatchesCurrentSession(upload)) return;
      mergeMessage(payload.data);
      state.pendingUpload = null;
      dom.composer_message.textContent = t('holdToTalk');
    } catch (error) {
      if (generation !== state.uploadGeneration || error?.name === 'AbortError') return;
      if (
        error.status === 401 &&
        !upload.renewed &&
        ['TOKEN_INVALID', 'GUEST_TOKEN_REVOKED', 'UNAUTHORIZED'].includes(error.code)
      ) {
        try {
          await renewGuestAccess();
          if (!uploadMatchesCurrentSession(upload)) return;
          upload.renewed = true;
          retryAfterRenew = true;
        } catch (renewError) {
          handleRoomError(renewError);
        }
      } else if (isTerminalError(error)) {
        handleRoomError(error);
      } else {
        dom.composer_message.textContent = t('uploadFailed');
        dom.retry_upload.hidden = false;
        showToast(errorMessage(error));
      }
    } finally {
      if (generation !== state.uploadGeneration) return;
      state.uploading = false;
      if (state.uploadAbortController === abortController) state.uploadAbortController = null;
      dom.record_button.disabled = state.ended || state.terminal;
      dom.record_button.classList.remove('uploading');
      dom.record_label.textContent = state.ended ? t('meetingEnded') : t('holdToTalk');
    }
    if (retryAfterRenew && generation === state.uploadGeneration && !state.terminal && !state.ended) {
      void uploadRecording(upload);
    }
  }

  function uploadMatchesCurrentSession(upload) {
    return Boolean(
      upload && state.session &&
      upload.conversationId === state.session.conversationId &&
      upload.participantId === state.participantId &&
      upload.guestIdentityId === state.session.guestIdentityId &&
      upload.sourceLanguage === state.session.profile?.preferredLanguage,
    );
  }

  function clearPendingUpload() {
    state.uploadGeneration += 1;
    try { state.uploadAbortController?.abort(); } catch (_) { /* already closed */ }
    state.uploadAbortController = null;
    state.pendingUpload = null;
    state.uploading = false;
    if (dom.retry_upload) dom.retry_upload.hidden = true;
    if (dom.record_button) {
      dom.record_button.classList.remove('uploading');
      dom.record_button.disabled = state.ended || state.terminal;
    }
  }

  async function playTts(message, button, retried = false) {
    if (!message.audioUrl) return;
    let url;
    try { url = new URL(message.audioUrl, window.location.origin); } catch (_) { return; }
    // Never attach a bearer credential to a URL outside the API origin, even
    // if a compromised payload contains such a URL.
    if (url.origin !== window.location.origin) {
      showToast(t('ttsUnavailable'));
      return;
    }
    stopCurrentAudio();
    const generation = state.audioGeneration;
    const conversationId = state.session?.conversationId;
    state.audioRequestButton = button;
    button.disabled = true;
    button.textContent = t('playing');
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${state.session.accessToken}` },
        cache: 'no-store', credentials: 'same-origin',
      });
      if (generation !== state.audioGeneration || state.session?.conversationId !== conversationId) {
        resetAudioButton(button);
        return;
      }
      if (!response.ok) {
        if (!retried && (response.status === 401 || response.status === 403)) {
          const refreshed = await refreshMessageAudio(message);
          if (refreshed?.audioUrl) return playTts(refreshed, button, true);
        }
        throw apiError(`HTTP_${response.status}`);
      }
      const blob = await response.blob();
      if (generation !== state.audioGeneration || state.session?.conversationId !== conversationId) {
        resetAudioButton(button);
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      const playback = { audio, objectUrl, button, cleaned: false };
      if (generation !== state.audioGeneration || state.terminal) {
        cleanupAudioPlayback(playback);
        return;
      }
      if (state.audioRequestButton === button) state.audioRequestButton = null;
      state.currentAudio = playback;
      const cleanup = () => cleanupAudioPlayback(playback);
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      await audio.play();
      if (generation !== state.audioGeneration && !playback.cleaned) {
        try { audio.pause(); } catch (_) { /* already stopped */ }
        cleanupAudioPlayback(playback);
      }
    } catch (error) {
      stopCurrentAudio();
      button.disabled = false;
      button.textContent = t('playTranslation');
      if (isTerminalError(error)) handleRoomError(error);
      else showToast(t('ttsUnavailable'));
    }
  }

  function cleanupAudioPlayback(playback) {
    if (!playback || playback.cleaned) return;
    playback.cleaned = true;
    URL.revokeObjectURL(playback.objectUrl);
    if (state.currentAudio === playback) state.currentAudio = null;
    if (playback.button?.isConnected) {
      playback.button.disabled = false;
      playback.button.textContent = t('playTranslation');
    }
  }

  function stopCurrentAudio() {
    state.audioGeneration += 1;
    const requestButton = state.audioRequestButton;
    state.audioRequestButton = null;
    resetAudioButton(requestButton);
    const playback = state.currentAudio;
    if (!playback) return;
    try { playback.audio.pause(); } catch (_) { /* already released */ }
    cleanupAudioPlayback(playback);
  }

  function resetAudioButton(button) {
    if (!button?.isConnected) return;
    button.disabled = false;
    button.textContent = t('playTranslation');
  }

  async function refreshMessageAudio(message) {
    const sequence = Math.max(0, (Number(message.sequence) || 1) - 1);
    const data = await jsonRequest(
      `/v1/conversations/${encodeURIComponent(state.session.conversationId)}/messages?afterSequence=${sequence}&limit=1`,
    );
    const fresh = (data.items || []).find((item) => (item.messageId || item.id) === message.id);
    if (fresh) mergeMessage(fresh, true);
    return fresh;
  }

  async function exportTranscript(retried = false) {
    if (!state.session?.conversationId) return;
    dom.export_txt.disabled = true;
    try {
      const response = await fetch(
        `/v1/conversations/${encodeURIComponent(state.session.conversationId)}/export?format=txt&groupBy=sequence`,
        {
          headers: { Authorization: `Bearer ${state.session.accessToken}` },
          cache: 'no-store', credentials: 'same-origin',
        },
      );
      if (response.status === 401 && !retried) {
        await renewGuestAccess();
        return exportTranscript(true);
      }
      if (!response.ok) {
        let payload;
        try { payload = await response.json(); } catch (_) { payload = null; }
        throw apiError(payload?.code || `HTTP_${response.status}`, payload?.message);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `conversation-${state.session.conversationId}.txt`;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      showToast(t('exported'));
    } catch (error) {
      if (isTerminalError(error)) handleRoomError(error);
      else showToast(errorMessage(error));
    } finally {
      dom.export_txt.disabled = false;
    }
  }

  async function leaveMeeting() {
    if (!state.session?.conversationId || !window.confirm(t('confirmLeave'))) return;
    dom.leave_button.disabled = true;
    try {
      await jsonRequest(`/v1/conversations/${encodeURIComponent(state.session.conversationId)}/leave`, {
        method: 'POST', body: {},
      });
      state.socket?.emit('room.leave', { conversationId: state.session.conversationId });
      showTerminal(t('leftTitle'), t('leftMessage'));
    } catch (error) {
      if (isTerminalError(error)) handleRoomError(error);
      else showToast(errorMessage(error));
    } finally {
      dom.leave_button.disabled = false;
    }
  }

  function handleParticipantRemoved(payload) {
    const participantId = payload?.participantId;
    if (!participantId) return;
    const participant = state.participants.get(participantId);
    if (participant) mergeParticipants([{ ...participant, presence: 'REMOVED', removedAt: payload.removedAt || new Date().toISOString() }]);
    if (participantId === state.participantId) {
      showTerminal(t('participantRemovedTitle'), t('participantRemovedMessage'));
    }
  }

  async function markMeetingEnded() {
    if (state.ended) return;
    state.ended = true;
    cancelRecording();
    stopCurrentAudio();
    clearPendingUpload();
    dom.record_button.disabled = true;
    dom.record_label.textContent = t('meetingEnded');
    dom.composer_message.textContent = t('endedReadOnly');
    setConnection('error', t('meetingEnded'));
    dom.active_speaker.hidden = true;
    if (state.conversation?.guestHistoryPolicy === 'NO_ACCESS_AFTER_END') {
      state.terminal = true;
      purgeRoomContent();
      clearAuthSession();
      state.socket?.disconnect();
      dom.terminal_title.textContent = t('meetingEnded');
      dom.terminal_message.textContent = t('roomUnavailableMessage');
      showOnly('terminal');
      return;
    }
    // The end transaction may have converted in-flight PROCESSING rows to
    // FAILED without a separate translation.failed event. Pull after the
    // terminal commit before closing realtime so the read-only transcript is
    // the authoritative final ledger.
    try {
      await pullAllMessages(contiguousCommittedSequence());
      await refreshParticipants();
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      state.socket?.disconnect();
    }
    showToast(t('endedReadOnly'));
  }

  function handleRoomError(rawError) {
    const error = normalizeSocketError(rawError);
    if (['PARTICIPANT_REMOVED', 'GUEST_PRINCIPAL_REVOKED'].includes(error.code)) {
      showTerminal(t('participantRemovedTitle'), t('participantRemovedMessage'));
      return;
    }
    if (error.code === 'ROOM_ENDED' && state.conversation) {
      void markMeetingEnded();
      return;
    }
    if (isTerminalError(error)) {
      showTerminal(t('roomUnavailableTitle'), t('roomUnavailableMessage'));
      return;
    }
    if (['TOKEN_INVALID', 'UNAUTHORIZED'].includes(error.code) || error.status === 401) {
      recoverRealtimeAuthentication();
      return;
    }
    setConnection('offline', t('reconnecting'));
    showToast(errorMessage(error));
  }

  function normalizeSocketError(value) {
    if (!value) return apiError('REQUEST_FAILED');
    if (value.code) return value;
    if (value.data?.code) return apiError(value.data.code, value.message);
    if (value.error?.code) return apiError(value.error.code, value.error.message);
    return apiError('REQUEST_FAILED', value.message);
  }

  function isTerminalError(error) {
    return [
      'PARTICIPANT_REMOVED', 'GUEST_PRINCIPAL_REVOKED', 'GUEST_TOKEN_REVOKED', 'GUEST_REFRESH_INVALID',
      'NOT_A_PARTICIPANT', 'CONVERSATION_NOT_FOUND', 'ROOM_NOT_FOUND',
      'ROOM_EXPIRED', 'ROOM_ENDED', 'ROOM_NOT_ACTIVE', 'HISTORY_ACCESS_EXPIRED',
    ].includes(error?.code);
  }

  function errorMessage(error) {
    const code = error?.code;
    const map = {
      NETWORK_ERROR: 'networkOffline', REALTIME_UNAVAILABLE: 'realtimeUnavailable',
      ROOM_NOT_FOUND: 'roomUnavailableMessage', ROOM_EXPIRED: 'roomUnavailableMessage',
      ROOM_ENDED: 'endedReadOnly', ROOM_NOT_ACTIVE: 'endedReadOnly',
      PARTICIPANT_REMOVED: 'participantRemovedMessage', GUEST_PRINCIPAL_REVOKED: 'participantRemovedMessage',
      NOT_A_PARTICIPANT: 'roomUnavailableMessage', GUEST_TOKEN_REVOKED: 'roomUnavailableMessage',
      GUEST_REFRESH_INVALID: 'roomUnavailableMessage',
      TOKEN_INVALID: 'roomUnavailableMessage', INVALID_AUDIO: 'recordingTooShort',
      PAYLOAD_TOO_LARGE: 'uploadFailed', PARTICIPANT_LANGUAGE_MISMATCH: 'requestFailed',
      ASR_NO_SPEECH: 'recordingTooShort', REALTIME_NOT_READY: 'reconnecting',
      PROVIDER_TIMEOUT: 'requestFailed', PROVIDER_RATE_LIMITED: 'requestFailed',
      RATE_LIMITED: 'requestFailed',
    };
    return map[code] ? t(map[code]) : t('requestFailed');
  }

  function showTerminal(title, message) {
    state.terminal = true;
    state.ended = true;
    cancelRecording();
    stopCurrentAudio();
    clearPendingUpload();
    state.socket?.disconnect();
    clearAuthSession();
    purgeRoomContent();
    dom.terminal_title.textContent = title;
    dom.terminal_message.textContent = message;
    showOnly('terminal');
  }

  function returnToJoin() {
    cancelRecording();
    stopCurrentAudio();
    clearPendingUpload();
    state.terminal = false;
    state.ended = false;
    purgeRoomContent();
    refreshInvitationUi();
    renderParticipants();
    updateEmptyTranscript();
    showOnly('join');
  }

  function clearAuthSession() {
    state.sessionGeneration += 1;
    state.session = null;
    writeJson(keys.session, null);
  }

  function purgeRoomContent() {
    state.conversation = null;
    state.participantId = null;
    state.participants.clear();
    state.messages.clear();
    state.messageElements.clear();
    state.syncPromise = null;
    dom.transcript.querySelectorAll('.message-card').forEach((element) => element.remove());
    dom.active_speaker.hidden = true;
    renderParticipants();
    updateEmptyTranscript();
  }

  function showJoinError(message) {
    dom.join_error.textContent = message;
    dom.join_error.hidden = false;
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 4200);
  }

  function openNativeApp() {
    const token = state.invitation.roomToken;
    if (!token) return;
    window.location.assign(`tooyei-translator://join/${encodeURIComponent(token)}`);
  }
})();
