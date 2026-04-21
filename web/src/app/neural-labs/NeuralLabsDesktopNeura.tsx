"use client";

import {
  useEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useTheme } from "next-themes";
import NeuralLabsTooltip from "@/app/neural-labs/NeuralLabsTooltip";
import Text from "@/refresh-components/texts/Text";
import type {
  DesktopNeuraWindowState,
  NeuraComposerAttachment,
  NeuraConversationSummary,
  NeuraMessage,
  NeuraMessageAttachment,
} from "@/app/neural-labs/types";
import {
  SvgArrowUp,
  SvgImage,
  SvgMicrophone,
  SvgPaperclip,
  SvgPlus,
  SvgSidebar,
  SvgSparkle,
  SvgTrash,
  SvgX,
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
  onAddAttachments: (conversationId: string, files: File[]) => void;
  onRemovePendingAttachment: (
    conversationId: string,
    attachmentId: string
  ) => void;
  getAttachmentContentUrl: (storagePath: string) => string;
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

function formatBytes(size: number | null): string {
  if (!size || size <= 0) {
    return "";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let currentValue = size / 1024;
  let unitIndex = 0;
  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }

  return `${
    currentValue >= 10 ? currentValue.toFixed(0) : currentValue.toFixed(1)
  } ${units[unitIndex]}`;
}

function PersistedAttachmentPreview({
  attachment,
  getAttachmentContentUrl,
}: {
  attachment: NeuraMessageAttachment;
  getAttachmentContentUrl: (storagePath: string) => string;
}) {
  const previewUrl = getAttachmentContentUrl(attachment.storage_path);
  return (
    <div className="overflow-hidden rounded-20 border border-black/5 bg-black/5 dark:border-white/10 dark:bg-white/[0.04]">
      <img
        src={previewUrl}
        alt={attachment.file_name}
        className="h-44 w-full object-cover"
        loading="lazy"
      />
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <Text className="truncate text-xs font-medium">
          {attachment.file_name}
        </Text>
        <Text className="shrink-0 text-[11px] text-slate-500 dark:text-white/45">
          {formatBytes(attachment.size)}
        </Text>
      </div>
    </div>
  );
}

function PendingAttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: NeuraComposerAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-24 border border-black/5 bg-white/70 dark:border-white/10 dark:bg-white/[0.06]">
      <img
        src={attachment.preview_url}
        alt={attachment.file_name}
        className="h-24 w-28 object-cover"
      />
      <button
        type="button"
        aria-label={`Remove ${attachment.file_name}`}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70"
        onClick={onRemove}
      >
        <SvgX className="h-3.5 w-3.5 stroke-current" />
      </button>
      <div className="px-3 py-2">
        <Text className="truncate text-xs font-medium">
          {attachment.file_name}
        </Text>
        <Text className="text-[11px] text-slate-500 dark:text-white/45">
          {formatBytes(attachment.size)}
        </Text>
      </div>
    </div>
  );
}

export default function NeuralLabsDesktopNeura({
  windowState,
  onToggleSidebar,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
  onUpdateDraft,
  onSendMessage,
  onAddAttachments,
  onRemovePendingAttachment,
  getAttachmentContentUrl,
}: NeuralLabsDesktopNeuraProps) {
  const { resolvedTheme } = useTheme();
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasBootstrappedConversationRef = useRef(false);
  const isDarkMode = resolvedTheme !== "light";
  const conversations = Array.isArray(windowState.conversations)
    ? windowState.conversations
    : [];
  const messagesByConversationId =
    windowState.messages_by_conversation_id ?? {};
  const draftsByConversationId = windowState.draft_by_conversation_id ?? {};
  const pendingAttachmentsByConversationId =
    windowState.pending_attachments_by_conversation_id ?? {};

  const activeConversation =
    conversations.find(
      (conversation) => conversation.id === windowState.selected_conversation_id
    ) ??
    conversations[0] ??
    null;
  const activeMessages = useMemo<NeuraMessage[]>(
    () =>
      activeConversation
        ? messagesByConversationId[activeConversation.id] ?? []
        : [],
    [activeConversation, messagesByConversationId]
  );
  const activeDraft = activeConversation
    ? draftsByConversationId[activeConversation.id] ?? ""
    : "";
  const pendingAttachments = activeConversation
    ? pendingAttachmentsByConversationId[activeConversation.id] ?? []
    : [];
  const renderedMessages = useMemo(
    () =>
      activeMessages.filter((message) => {
        const attachments = Array.isArray(message.attachments)
          ? message.attachments
          : [];
        if (message.role !== "assistant") {
          return true;
        }
        return Boolean(message.content?.trim()) || attachments.length > 0;
      }),
    [activeMessages]
  );
  const lastMessage = activeMessages[activeMessages.length - 1];
  const shouldShowThinkingBubble = useMemo(() => {
    if (!windowState.is_streaming) {
      return false;
    }
    if (!lastMessage || lastMessage.role !== "assistant") {
      return true;
    }
    const attachments = Array.isArray(lastMessage.attachments)
      ? lastMessage.attachments
      : [];
    return !lastMessage.content?.trim() && attachments.length === 0;
  }, [lastMessage, windowState.is_streaming]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    timeline.scrollTop = timeline.scrollHeight;
  }, [
    activeConversation?.id,
    activeMessages,
    pendingAttachments.length,
    windowState.is_streaming,
  ]);

  useEffect(() => {
    if (
      hasBootstrappedConversationRef.current ||
      windowState.is_loading_conversations ||
      conversations.length > 0
    ) {
      return;
    }

    hasBootstrappedConversationRef.current = true;
    void onCreateConversation();
  }, [
    conversations.length,
    onCreateConversation,
    windowState.is_loading_conversations,
  ]);

  useEffect(() => {
    if (!activeConversation || windowState.is_streaming) {
      return;
    }

    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [activeConversation?.id, windowState.is_streaming]);

  const chromeClassName = isDarkMode
    ? "border-white/10 bg-[linear-gradient(180deg,rgba(11,18,31,0.92),rgba(7,11,21,0.92))] text-white"
    : "border-slate-200/80 bg-[linear-gradient(180deg,rgba(250,252,255,0.96),rgba(242,246,252,0.96))] text-slate-900";
  const sidebarClassName = isDarkMode
    ? "border-white/10 bg-white/[0.04]"
    : "border-slate-200/80 bg-white/70";
  const mutedClassName = isDarkMode ? "text-white/55" : "text-slate-500";
  const surfaceClassName = isDarkMode
    ? "border-white/10 bg-white/[0.04]"
    : "border-slate-200/80 bg-white/72";
  const messageShellClassName = isDarkMode
    ? "border-white/10 bg-[#0b1322]/85"
    : "border-slate-200/90 bg-white/88";
  const composerShellClassName = isDarkMode
    ? "border-white/10 bg-[#0a1120]/92 shadow-[0_28px_60px_rgba(0,0,0,0.28)]"
    : "border-slate-200/80 bg-white/95 shadow-[0_20px_45px_rgba(15,23,42,0.12)]";
  const composerInputClassName = isDarkMode
    ? "text-white placeholder:text-white/35"
    : "text-slate-900 placeholder:text-slate-400";

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || !activeConversation) {
      return;
    }

    event.preventDefault();
    void onSendMessage(activeConversation.id);
  };

  const handleAttachmentInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (!activeConversation) {
      event.target.value = "";
      return;
    }

    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) {
      onAddAttachments(activeConversation.id, files);
    }
    event.target.value = "";
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
            ) : conversations.length === 0 ? (
              <div className={`px-3 py-4 text-sm ${mutedClassName}`}>
                No conversations yet.
              </div>
            ) : (
              conversations.map((conversation) => {
                const isActive = conversation.id === activeConversation?.id;
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    className={`group mb-1 flex w-full items-start gap-3 rounded-16 px-3 py-3 text-left transition ${
                      isActive
                        ? isDarkMode
                          ? "bg-white/12 text-white"
                          : "bg-slate-950 text-white shadow-[0_10px_30px_rgba(15,23,42,0.18)]"
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
                      <Text
                        className={`truncate text-sm font-medium ${
                          isActive
                            ? "text-white"
                            : "text-slate-900 dark:text-white"
                        }`}
                      >
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
                    {windowState.default_model || "Sonnet"} • Vision enabled
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
                className={`max-w-md rounded-24 border px-8 py-8 text-center ${surfaceClassName}`}
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
                className={`max-w-xl rounded-24 border px-8 py-8 ${surfaceClassName}`}
              >
                <Text className="text-lg font-medium">
                  Ask {windowState.assistant_name} anything
                </Text>
                <Text className={`mt-2 text-sm ${mutedClassName}`}>
                  This chat is separate from Onyx and stored in your Neural Labs
                  environment. Image uploads are sent to Sonnet with the
                  message.
                </Text>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {renderedMessages.map((message) => {
                const isAssistant = message.role === "assistant";
                const attachments = Array.isArray(message.attachments)
                  ? message.attachments
                  : [];
                return (
                  <div
                    key={message.id}
                    className={`flex ${
                      isAssistant ? "justify-start" : "justify-end"
                    }`}
                  >
                    <div
                      className={`max-w-[86%] rounded-[26px] border px-4 py-3 ${messageShellClassName} ${
                        isAssistant
                          ? ""
                          : isDarkMode
                            ? "bg-cyan-400/14 text-white"
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
                      {attachments.length > 0 ? (
                        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {attachments.map((attachment) => (
                            <PersistedAttachmentPreview
                              key={attachment.id}
                              attachment={attachment}
                              getAttachmentContentUrl={getAttachmentContentUrl}
                            />
                          ))}
                        </div>
                      ) : null}
                      {message.content ? (
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
                          {message.content}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {shouldShowThinkingBubble ? (
                <div className="flex justify-start">
                  <div
                    className={`max-w-[82%] rounded-[26px] border px-4 py-3 ${messageShellClassName}`}
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

            <div
              className={`rounded-[30px] border p-3 ${composerShellClassName}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleAttachmentInput}
              />

              {pendingAttachments.length > 0 ? (
                <div className="mb-3 flex gap-3 overflow-x-auto pb-1">
                  {pendingAttachments.map((attachment) => (
                    <PendingAttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={() => {
                        if (!activeConversation) {
                          return;
                        }
                        onRemovePendingAttachment(
                          activeConversation.id,
                          attachment.id
                        );
                      }}
                    />
                  ))}
                </div>
              ) : null}

              <div className="flex items-end gap-3">
                <div className="flex shrink-0 items-center gap-2 pb-2">
                  <NeuralLabsTooltip label="Voice Input">
                    <button
                      type="button"
                      aria-label="Voice input"
                      disabled
                      className={`flex h-11 w-11 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        isDarkMode
                          ? "bg-white/8 text-white"
                          : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      <SvgMicrophone className="h-4 w-4 stroke-current" />
                    </button>
                  </NeuralLabsTooltip>
                  <NeuralLabsTooltip label="Attach File">
                    <button
                      type="button"
                      aria-label="Attach file"
                      disabled={!activeConversation || windowState.is_streaming}
                      className={`flex h-11 w-11 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        isDarkMode
                          ? "bg-white/8 text-white hover:bg-white/12"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <SvgPaperclip className="h-4 w-4 stroke-current" />
                    </button>
                  </NeuralLabsTooltip>
                  <NeuralLabsTooltip label="Upload Image">
                    <button
                      type="button"
                      aria-label="Upload image"
                      disabled={!activeConversation || windowState.is_streaming}
                      className={`flex h-11 w-11 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        isDarkMode
                          ? "bg-white/8 text-white hover:bg-white/12"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <SvgImage className="h-4 w-4 stroke-current" />
                    </button>
                  </NeuralLabsTooltip>
                </div>

                <div className="min-w-0 flex-1">
                  <textarea
                    ref={textareaRef}
                    value={activeDraft}
                    disabled={!activeConversation || windowState.is_streaming}
                    placeholder={
                      activeConversation
                        ? `Message ${windowState.assistant_name} or drop in images...`
                        : "Create a chat to start messaging"
                    }
                    className={`min-h-[72px] w-full resize-none bg-transparent px-1 py-2 text-sm outline-none ${composerInputClassName}`}
                    onChange={(event) => {
                      if (!activeConversation) {
                        return;
                      }
                      onUpdateDraft(activeConversation.id, event.target.value);
                    }}
                    onKeyDown={handleComposerKeyDown}
                  />
                </div>

                <NeuralLabsTooltip label="Send Message">
                  <button
                    type="button"
                    aria-label="Send message"
                    disabled={
                      !activeConversation ||
                      windowState.is_streaming ||
                      (!activeDraft.trim() && pendingAttachments.length === 0)
                    }
                    className={`mb-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
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
                </NeuralLabsTooltip>
              </div>
            </div>

            <Text className={`px-1 text-[11px] ${mutedClassName}`}>
              Enter sends. Shift+Enter adds a new line.
            </Text>
          </div>
        </div>
      </div>
    </div>
  );
}
