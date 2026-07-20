export interface RealtimeHub {
  emitToConversation(conversationId: string, event: string, payload: unknown): void;
  emitToSubject(subjectId: string, event: string, payload: unknown): void;
  disconnectDevice(subjectId: string, deviceId: string): void;
  disconnectSubject(subjectId: string): void;
  disconnectParticipant(conversationId: string, participantId: string): Promise<boolean>;
  disconnectDirectChatParticipant(
    conversationId: string,
    participantId: string,
  ): Promise<boolean>;
  stopFriendCallTranslation(callId: string): void;
  isSubjectOnline(subjectId: string): Promise<boolean>;
  isReady(): boolean;
}

let hub: RealtimeHub = {
  emitToConversation: () => undefined,
  emitToSubject: () => undefined,
  disconnectDevice: () => undefined,
  disconnectSubject: () => undefined,
  disconnectParticipant: async () => true,
  disconnectDirectChatParticipant: async () => true,
  stopFriendCallTranslation: () => undefined,
  isSubjectOnline: async () => false,
  isReady: () => true,
};

export const realtimeHub = (): RealtimeHub => hub;

export const setRealtimeHub = (value: RealtimeHub): void => {
  hub = value;
};
