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
  | "text-editor";

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
