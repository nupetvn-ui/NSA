import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyEvent,
  type AgentInfo,
  type CliChange,
  type Conversation,
  type SendRequest,
} from '@nsa/core';

/** Trạng thái chat phía giao diện: đồng bộ từ lõi và áp sự kiện trực tiếp khi agent đang trả lời. */
export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [checkingAgents, setCheckingAgents] = useState(true);
  const [cliChanges, setCliChanges] = useState<CliChange[]>([]);
  const refreshTimer = useRef<number | undefined>(undefined);
  /** Tập mã lượt đang có trong bộ nhớ giao diện, để biết sự kiện nào áp trực tiếp được. */
  const knownTurns = useRef(new Set<string>());

  useEffect(() => {
    knownTurns.current = new Set(conversations.flatMap((c) => c.turns.map((t) => t.id)));
  }, [conversations]);

  const reload = useCallback(async () => {
    setConversations(await window.nsa.invoke('chat:list'));
  }, []);

  /** Gộp nhiều yêu cầu tải lại liên tiếp thành một. */
  const scheduleReload = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void reload(), 50);
  }, [reload]);

  const checkAgents = useCallback(async () => {
    setCheckingAgents(true);
    try {
      setAgents(await window.nsa.invoke('agents:list'));
    } finally {
      setCheckingAgents(false);
    }
  }, []);

  useEffect(() => {
    void window.nsa.invoke('chat:list').then(setConversations);
    void window.nsa
      .invoke('agents:list')
      .then(setAgents)
      .finally(() => setCheckingAgents(false));

    void window.nsa.invoke('agents:changes').then(setCliChanges);
    const offChanges = window.nsa.on('agents:changes', setCliChanges);

    const offEvents = window.nsa.on('chat:event', ({ conversationId, turnId, event, agentId }) => {
      if (!knownTurns.current.has(turnId)) {
        // Lượt chưa có trong giao diện: lấy bản chuẩn từ lõi (đã gồm sự kiện này).
        scheduleReload();
        return;
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== conversationId
            ? c
            : {
                ...c,
                turns: c.turns.map((t) =>
                  // NSA có thể đổi agent giữa lượt (agent hỏng / chưa cài).
                  t.id === turnId ? applyEvent({ ...t, agentId }, event) : t,
                ),
              },
        ),
      );
      if (event.type === 'done') scheduleReload();
    });
    return () => {
      offChanges();
      offEvents();
    };
  }, [scheduleReload]);

  const send = useCallback(
    async (request: SendRequest) => {
      const result = await window.nsa.invoke('chat:send', request);
      await reload();
      return result;
    },
    [reload],
  );

  const cancel = useCallback((turnId: string) => window.nsa.invoke('chat:cancel', turnId), []);

  const answerPermission = useCallback(
    (permissionId: string, allowed: boolean) =>
      window.nsa.invoke('chat:answerPermission', permissionId, allowed),
    [],
  );

  const remove = useCallback(
    async (conversationId: string) => {
      await window.nsa.invoke('chat:delete', conversationId);
      await reload();
    },
    [reload],
  );

  return {
    conversations,
    agents,
    checkingAgents,
    checkAgents,
    cliChanges,
    dismissChanges: () => setCliChanges([]),
    send,
    cancel,
    answerPermission,
    remove,
  };
}
