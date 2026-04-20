"use client";

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useTheme } from "next-themes";
import Text from "@/refresh-components/texts/Text";
import type {
  DesktopNeuraWindowState,
  NeuraConversationSummary,
  NeuraMessage,
} from "@/app/neural-labs/types";
import {
  SvgArrowUp,
  SvgPlus,
  SvgSidebar,
  SvgSparkle,
  SvgTrash,
} from "@opal/icons";

interface NeuralLabsDesktopNeuraProps {
  windowState: DesktopNeuraWindowState;
  onToggleSidebar: () => void;
  onCreateConversation: () => Promise<void> | void;
  onSelectConversation: (conversationId: string) => Promise<void> | void;
  onDeleteConversation: (
    conversation: NeuraConversationSummary
  ) => Promise<void> | void;
  onUpdateDraft: (conversationId: string, draft: string) => void;
  onSendMessage: (conversationId: string) => Promise<void> | void;
}

function formatConversationTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export default function NeuralLabsDesktopNeura({
  windowState,
  onToggleSidebar,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
  onUpdateDraft,
  onSendMessage,
}: NeuralLabsDesktopNeuraProps) {
  const { resolvedTheme } = useTheme();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const isDarkMode = resolvedTheme !== "light";

  const activeConversation =
    windowState.conversations.find(
      (conversation) => conversation.id === windowState.selected_conversation_id
    ) ??
    windowState.conversations[0] ??
    null;
  const activeMessages = useMemo<NeuraMessage[]>(
    () =>
      activeConversation
        ? windowState.messages_by_conversation_id[activeConversation.id] ?? []
        : [],
    [activeConversation, windowState.messages_by_conversation_id]
  );
  const activeDraft = activeConversation
    ? windowState.draft_by_conversation_id[activeConversation.id] ?? ""
    : "";

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    timeline.scrollTop = timeline.scrollHeight;
  }, [activeConversation?.id, activeMessages, windowState.is_streaming]);

  const chromeClassName = isDarkMode
    ? "border-white/10 bg-[linear-gradient(180deg,rgba(11,18,31,0.92),rgba(7,11,21,0.92))] text-white"
    : "border-slate-200/80 bg-[linear-gradient(180deg,rgba(250,252,255,0.96),rgba(242,246,252,0.96))] text-slate-900";
  const sidebarClassName = isDarkMode
    ? "border-white/10 bg-white/[0.04]"
    : "border-slate-200/80 bg-white/70";
  const inputClassName = isDarkMode
    ? "border-white/10 bg-black/20 text-white placeholder:text-white/35"
    : "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400";
  const mutedClassName = isDarkMode ? "text-white/55" : "text-slate-500";

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || !activeConversation) {
      return;
    }

    event.preventDefault();
    void onSendMessage(activeConversation.id);
  };

  return (
    <div className={`flex h-full min-h-0 ${chromeClassName}`}>
      {windowState.is_sidebar_open ? (
        <aside
          className={`flex w-72 shrink-0 flex-col border-r ${sidebarClassName}`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-inherit px-4 py-3">
            <div className="min-w-0">
              <Text className="text-xs font-medium uppercase tracking-[0.24em]">
                {windowState.assistant_name}
              </Text>
              <Text className={`mt-1 text-sm ${mutedClassName}`}>
                {windowState.default_model || "Sonnet"}
              </Text>
            </div>
            <button
              type="button"
              aria-label="New conversation"
              className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
                isDarkMode
                  ? "bg-white/8 text-white hover:bg-white/14"
                  : "bg-slate-900 text-white hover:bg-slate-700"
              }`}
              onClick={() => void onCreateConversation()}
            >
              <SvgPlus className="h-4 w-4 stroke-current" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {windowState.is_loading_conversations ? (
              <div className={`px-3 py-4 text-sm ${mutedClassName}`}>
                Loading conversations...
              </div>
            ) : windowState.conversations.length === 0 ? (
              <div className={`px-3 py-4 text-sm ${mutedClassName}`}>
                No conversations yet.
              </div>
            ) : (
              windowState.conversations.map((conversation) => {
                const isActive = conversation.id === activeConversation?.id;
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    className={`group mb-1 flex w-full items-start gap-3 rounded-16 px-3 py-3 text-left transition ${
                      isActive
                        ? isDarkMode
                          ? "bg-white/12"
                          : "bg-slate-900 text-white"
                        : isDarkMode
                          ? "hover:bg-white/7"
                          : "hover:bg-slate-100"
                    }`}
                    onClick={() => void onSelectConversation(conversation.id)}
                  >
                    <div
                      className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        isActive
                          ? isDarkMode
                            ? "bg-cyan-400/20 text-cyan-200"
                            : "bg-white/20 text-white"
                          : isDarkMode
                            ? "bg-white/7 text-white/75"
                            : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      <SvgSparkle className="h-4 w-4 fill-current stroke-none" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Text className="truncate text-sm font-medium">
                        {conversation.title}
                      </Text>
                      <Text
                        className={`mt-1 truncate text-xs ${
                          isActive
                            ? isDarkMode
                              ? "text-white/65"
                              : "text-white/75"
                            : mutedClassName
                        }`}
                      >
                        {formatConversationTimestamp(conversation.updated_at)}
                      </Text>
                    </div>
                    <button
                      type="button"
                      aria-label={`Delete ${conversation.title}`}
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100 ${
                        isActive
                          ? isDarkMode
                            ? "hover:bg-white/12"
                            : "hover:bg-white/20"
                          : isDarkMode
                            ? "hover:bg-white/10"
                            : "hover:bg-slate-200"
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onDeleteConversation(conversation);
                      }}
                    >
                      <SvgTrash className="h-4 w-4 stroke-current" />
                    </button>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <header
          className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${
            isDarkMode
              ? "border-white/10 bg-white/[0.03]"
              : "border-slate-200/80 bg-white/55"
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="Toggle conversation sidebar"
              className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
                isDarkMode
                  ? "text-white/80 hover:bg-white/10"
                  : "text-slate-600 hover:bg-slate-200/80"
              }`}
              onClick={onToggleSidebar}
            >
              <SvgSidebar className="h-4 w-4 stroke-current" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full ${
                    isDarkMode
                      ? "bg-cyan-400/16 text-cyan-200"
                      : "bg-slate-900 text-white"
                  }`}
                >
                  <SvgSparkle className="h-4 w-4 fill-current stroke-none" />
                </div>
                <div className="min-w-0">
                  <Text className="truncate text-sm font-medium">
                    {activeConversation?.title ?? "Neura"}
                  </Text>
                  <Text className={`truncate text-xs ${mutedClassName}`}>
                    {windowState.assistant_name} •{" "}
                    {windowState.default_model || "Sonnet"}
                  </Text>
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm transition ${
              isDarkMode
                ? "bg-white/8 text-white/85 hover:bg-white/12"
                : "bg-slate-900 text-white hover:bg-slate-700"
            }`}
            onClick={() => void onCreateConversation()}
          >
            <SvgPlus className="h-4 w-4 stroke-current" />
            New Chat
          </button>
        </header>

        <div
          ref={timelineRef}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
        >
          {!activeConversation ? (
            <div className="flex h-full items-center justify-center">
              <div
                className={`max-w-md rounded-24 border px-8 py-8 text-center ${
                  isDarkMode
                    ? "border-white/10 bg-white/[0.04]"
                    : "border-slate-200/80 bg-white/70"
                }`}
              >
                <div
                  className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${
                    isDarkMode
                      ? "bg-cyan-400/16 text-cyan-200"
                      : "bg-slate-900 text-white"
                  }`}
                >
                  <SvgSparkle className="h-7 w-7 fill-current stroke-none" />
                </div>
                <Text className="mt-4 text-lg font-medium">
                  Start a conversation with {windowState.assistant_name}
                </Text>
                <Text className={`mt-2 text-sm ${mutedClassName}`}>
                  Create a new chat from the sidebar or the button above. Your
                  history stays inside your Neural Labs workspace.
                </Text>
              </div>
            </div>
          ) : activeMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div
                className={`max-w-xl rounded-24 border px-8 py-8 ${
                  isDarkMode
                    ? "border-white/10 bg-white/[0.04]"
                    : "border-slate-200/80 bg-white/70"
                }`}
              >
                <Text className="text-lg font-medium">
                  Ask {windowState.assistant_name} anything
                </Text>
                <Text className={`mt-2 text-sm ${mutedClassName}`}>
                  This chat is separate from Onyx and stored in your Neural Labs
                  environment.
                </Text>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {activeMessages.map((message) => {
                const isAssistant = message.role === "assistant";
                return (
                  <div
                    key={message.id}
                    className={`flex ${
                      isAssistant ? "justify-start" : "justify-end"
                    }`}
                  >
                    <div
                      className={`max-w-[82%] rounded-24 px-4 py-3 ${
                        isAssistant
                          ? isDarkMode
                            ? "border border-white/10 bg-white/[0.06]"
                            : "border border-slate-200 bg-white"
                          : isDarkMode
                            ? "bg-cyan-400/16 text-white"
                            : "bg-slate-900 text-white"
                      }`}
                    >
                      <div
                        className={`mb-2 text-xs font-medium ${
                          isAssistant ? mutedClassName : "text-white/70"
                        }`}
                      >
                        {isAssistant ? windowState.assistant_name : "You"}
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
                        {message.content}
                      </pre>
                    </div>
                  </div>
                );
              })}
              {windowState.is_streaming ? (
                <div className="flex justify-start">
                  <div
                    className={`max-w-[82%] rounded-24 border px-4 py-3 ${
                      isDarkMode
                        ? "border-white/10 bg-white/[0.06]"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div
                      className={`mb-2 text-xs font-medium ${mutedClassName}`}
                    >
                      {windowState.assistant_name}
                    </div>
                    <div className={`text-sm ${mutedClassName}`}>
                      Thinking...
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div
          className={`border-t px-5 py-4 ${
            isDarkMode
              ? "border-white/10 bg-white/[0.03]"
              : "border-slate-200/80 bg-white/55"
          }`}
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-3">
            {windowState.error_message ? (
              <div
                className={`rounded-16 border px-4 py-3 text-sm ${
                  isDarkMode
                    ? "border-rose-400/30 bg-rose-400/10 text-rose-100"
                    : "border-rose-200 bg-rose-50 text-rose-700"
                }`}
              >
                {windowState.error_message}
              </div>
            ) : null}
            <div className="flex items-end gap-3">
              <textarea
                value={activeDraft}
                disabled={!activeConversation || windowState.is_streaming}
                placeholder={
                  activeConversation
                    ? `Message ${windowState.assistant_name}...`
                    : "Create a chat to start messaging"
                }
                className={`min-h-[104px] flex-1 resize-none rounded-24 border px-4 py-3 text-sm outline-none transition focus:ring-2 focus:ring-cyan-400/40 ${inputClassName}`}
                onChange={(event) => {
                  if (!activeConversation) {
                    return;
                  }
                  onUpdateDraft(activeConversation.id, event.target.value);
                }}
                onKeyDown={handleComposerKeyDown}
              />
              <button
                type="button"
                aria-label="Send message"
                disabled={
                  !activeConversation ||
                  windowState.is_streaming ||
                  !activeDraft.trim()
                }
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  isDarkMode
                    ? "bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                    : "bg-slate-900 text-white hover:bg-slate-700"
                }`}
                onClick={() => {
                  if (!activeConversation) {
                    return;
                  }
                  void onSendMessage(activeConversation.id);
                }}
              >
                <SvgArrowUp className="h-4 w-4 stroke-current" />
              </button>
            </div>
            <Text className={`text-xs ${mutedClassName}`}>
              Enter sends. Shift+Enter adds a new line.
            </Text>
          </div>
        </div>
      </div>
    </div>
  );
}
