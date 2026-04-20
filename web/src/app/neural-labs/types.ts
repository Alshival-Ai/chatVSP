"use client";

export interface NeuralLabsFileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  mime_type: string | null;
  size: number | null;
  modified_at: string | null;
}

export interface DirectoryResponse {
  path: string;
  entries: NeuralLabsFileEntry[];
}

export type PreviewKind = "image" | "html" | "text" | "pdf" | "kmz" | "xlsx";

export type PreviewSnapZone =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface PreviewWindowState {
  id: string;
  path: string;
  name: string;
  mime_type: string | null;
  preview_kind: PreviewKind;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  snapped_zone: PreviewSnapZone | null;
  is_maximized: boolean;
  is_minimized: boolean;
  restore_bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
    snapped_zone: PreviewSnapZone | null;
  } | null;
}

export type NeuralLabsDesktopAppKind =
  | "file-explorer"
  | "terminal-workspace"
  | "desktop-settings"
  | "text-editor"
  | "neura-chat";

export type DesktopExplorerViewMode = "icon" | "list";

export type SplitMode = "none" | "horizontal" | "vertical";

export interface TerminalPaneState {
  pane_id: string;
  terminal_id: string;
}

export interface TerminalTabState {
  tab_id: string;
  title: string;
  split_mode: SplitMode;
  panes: TerminalPaneState[];
  active_pane_id: string;
}

export interface TerminalLayoutState {
  tabs: TerminalTabState[];
  active_tab_id: string;
}

export interface DesktopTerminalWindowState {
  layout: TerminalLayoutState | null;
  is_initializing: boolean;
}

export interface DesktopEditorTabState {
  tab_id: string;
  path: string | null;
  name: string;
  mime_type: string | null;
  content: string;
  saved_content: string;
  is_loading: boolean;
  is_saving: boolean;
  error_message: string | null;
  last_saved_at: number | null;
}

export interface DesktopEditorWindowState {
  tabs: DesktopEditorTabState[];
  active_tab_id: string;
  is_sidebar_open: boolean;
}

export interface NeuraConversationSummary {
  id: string;
  title: string;
  model_name: string;
  created_at: string;
  updated_at: string;
}

export interface NeuraMessageAttachment {
  id: string;
  message_id: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size: number | null;
}

export interface NeuraMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  attachments: NeuraMessageAttachment[];
}

export interface NeuraComposerAttachment {
  id: string;
  file: File;
  file_name: string;
  mime_type: string;
  size: number;
  preview_url: string;
}

export interface DesktopNeuraWindowState {
  conversations: NeuraConversationSummary[];
  selected_conversation_id: string | null;
  messages_by_conversation_id: Record<string, NeuraMessage[]>;
  draft_by_conversation_id: Record<string, string>;
  pending_attachments_by_conversation_id: Record<
    string,
    NeuraComposerAttachment[]
  >;
  is_sidebar_open: boolean;
  is_loading_conversations: boolean;
  is_loading_messages: boolean;
  is_streaming: boolean;
  error_message: string | null;
  assistant_name: string;
  default_model: string;
}

export interface DesktopExplorerState {
  current_path: string;
  back_history: string[];
  forward_history: string[];
  selected_paths: string[];
  anchor_path: string | null;
  view_mode: DesktopExplorerViewMode;
}

export interface DesktopWindowState {
  id: string;
  app_kind: NeuralLabsDesktopAppKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  snapped_zone: PreviewSnapZone | null;
  is_maximized: boolean;
  is_minimized: boolean;
  restore_bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
    snapped_zone: PreviewSnapZone | null;
  } | null;
}
