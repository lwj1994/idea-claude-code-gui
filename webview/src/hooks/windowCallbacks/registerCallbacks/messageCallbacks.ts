/**
 * messageCallbacks.ts
 *
 * Registers window bridge callbacks for message management:
 * updateMessages, updateStatus, showLoading, showThinkingStatus,
 * setHistoryData, clearMessages, addErrorMessage, addHistoryMessage,
 * historyLoadComplete, addUserMessage.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import {
  appendOptimisticMessageIfMissing,
  preserveLastAssistantIdentity,
  preserveStreamingAssistantContent,
} from '../messageSync';
import { releaseSessionTransition } from '../sessionTransition';

const isTruthy = (v: unknown) => v === true || v === 'true';

export function registerMessageCallbacks(
  options: UseWindowCallbacksOptions,
  resetTransientUiState: () => void,
): void {
  const {
    addToast,
    setMessages,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setHistoryData,
    userPausedRef,
    isUserAtBottomRef,
    messagesContainerRef,
    suppressNextStatusToastRef,
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    activeTextSegmentIndexRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    streamingMessageIndexRef,
    findLastAssistantIndex,
    extractRawBlocks,
    patchAssistantForStreaming,
  } = options;

  window.updateMessages = (json) => {
    // During session transition, ignore message updates from stale session
    // callbacks to prevent cleared messages from being restored
    if (window.__sessionTransitioning) return;

    try {
      const parsed = JSON.parse(json) as ClaudeMessage[];

      setMessages((prev) => {
        // If streaming is active, delegate to the streaming logic
        if (isStreamingRef.current) {
          if (useBackendStreamingRenderRef.current) {
            let smartMerged = parsed.map((newMsg, i) => {
              if (i === parsed.length - 1) return newMsg;
              if (i < prev.length) {
                const oldMsg = prev[i];
                if (
                  oldMsg.timestamp === newMsg.timestamp &&
                  oldMsg.type === newMsg.type &&
                  oldMsg.content === newMsg.content
                ) {
                  return oldMsg;
                }
              }
              return newMsg;
            });

            smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
            smartMerged = preserveStreamingAssistantContent(
              prev,
              smartMerged,
              isStreamingRef,
              streamingContentRef,
              findLastAssistantIndex,
              patchAssistantForStreaming,
            );
            const result = appendOptimisticMessageIfMissing(prev, smartMerged);

            // FIX: In Claude mode, update streamingMessageIndexRef so that
            // onContentDelta knows which assistant message to update.
            const lastAssistantIdx = findLastAssistantIndex(result);
            if (lastAssistantIdx >= 0) {
              streamingMessageIndexRef.current = lastAssistantIdx;

              // FIX: If there is buffered streaming content (onContentDelta may
              // fire before updateMessages), apply it to the assistant message
              // immediately to prevent content loss.
              if (streamingContentRef.current && result[lastAssistantIdx]?.type === 'assistant') {
                const backendContent = result[lastAssistantIdx].content || '';
                if (streamingContentRef.current.length >= backendContent.length) {
                  result[lastAssistantIdx] = patchAssistantForStreaming({
                    ...result[lastAssistantIdx],
                    content: streamingContentRef.current,
                    isStreaming: true,
                  });
                } else {
                  // Backend has more complete content; sync buffer
                  streamingContentRef.current = backendContent;
                }
              }
            }

            return result;
          }

          const lastAssistantIdx = findLastAssistantIndex(parsed);
          if (lastAssistantIdx < 0) {
            return appendOptimisticMessageIfMissing(prev, parsed);
          }
        }

        // Non-streaming case (or streaming hasn't started yet)
        if (!isStreamingRef.current) {
          // Smart merge: reuse old message objects for performance
          let smartMerged = parsed.map((newMsg, i) => {
            if (i === parsed.length - 1) return newMsg;
            if (i < prev.length) {
              const oldMsg = prev[i];
              if (
                oldMsg.timestamp === newMsg.timestamp &&
                oldMsg.type === newMsg.type &&
                oldMsg.content === newMsg.content
              ) {
                return oldMsg;
              }
            }
            return newMsg;
          });

          smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
          return appendOptimisticMessageIfMissing(prev, smartMerged);
        }

        // Streaming + !useBackendStreamingRender: only update on tool_use changes
        const lastAssistantIdx = findLastAssistantIndex(parsed);
        if (lastAssistantIdx < 0) {
          return parsed;
        }

        const lastAssistant = parsed[lastAssistantIdx];
        const lastAssistantBlocks = extractRawBlocks(lastAssistant.raw);
        const toolUseCount = lastAssistantBlocks.filter((b) => b?.type === 'tool_use').length;
        if (toolUseCount < seenToolUseCountRef.current) {
          seenToolUseCountRef.current = toolUseCount;
        }
        const hasNewToolUse = toolUseCount > seenToolUseCountRef.current;
        const hasToolUse = toolUseCount > 0;

        if (!hasNewToolUse && !hasToolUse) {
          return prev;
        }

        if (hasNewToolUse) {
          seenToolUseCountRef.current = toolUseCount;
          activeTextSegmentIndexRef.current = -1;
          activeThinkingSegmentIndexRef.current = -1;
        }

        let patched = [...parsed];
        patched = appendOptimisticMessageIfMissing(prev, patched);
        patched = preserveLastAssistantIdentity(prev, patched, findLastAssistantIndex);
        patched = preserveStreamingAssistantContent(
          prev,
          patched,
          isStreamingRef,
          streamingContentRef,
          findLastAssistantIndex,
          patchAssistantForStreaming,
        );

        const patchedAssistantIdx = findLastAssistantIndex(patched);
        if (patchedAssistantIdx >= 0 && patched[patchedAssistantIdx]?.type === 'assistant') {
          streamingMessageIndexRef.current = patchedAssistantIdx;
          patched[patchedAssistantIdx] = patchAssistantForStreaming(patched[patchedAssistantIdx]);
        }

        return patched;
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse messages:', error);
    }
  };

  window.updateStatus = (text) => {
    // Do not release the transition guard from generic status updates.
    setStatus(text);
    if (suppressNextStatusToastRef.current) {
      suppressNextStatusToastRef.current = false;
      return;
    }
    addToast(text);
  };

  window.showLoading = (value) => {
    const isLoading = isTruthy(value);

    // FIX: Ignore loading=false during streaming — onStreamEnd handles it uniformly.
    if (!isLoading && isStreamingRef.current) {
      return;
    }

    // Notify backend about loading state change for tab indicator
    sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

    setLoading((prevLoading) => {
      if (isLoading) {
        if (!prevLoading) {
          setLoadingStartTime(Date.now());
        }
      } else {
        setLoadingStartTime(null);
      }
      return isLoading;
    });
  };

  window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
  window.setHistoryData = (data) => setHistoryData(data);

  window.clearMessages = () => {
    window.__deniedToolIds?.clear();
    resetTransientUiState();
    setMessages([]);
  };

  window.addErrorMessage = (message) => {
    addToast(message, 'error');
  };

  window.addHistoryMessage = (message: ClaudeMessage) => {
    setMessages((prev) => [...prev, message]);
  };

  // History load complete callback — triggers Markdown re-rendering
  window.historyLoadComplete = () => {
    releaseSessionTransition();
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1] };
      return updated;
    });
  };

  window.addUserMessage = (content: string) => {
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: content || '',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });
  };

}
