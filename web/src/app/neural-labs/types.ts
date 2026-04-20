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

export type PreviewKind =
  | "image"
  | "html"
  | "text"
  | "pdf"
  | "kmz"
  | "xlsx"
  | "app-text-editor";

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
  | "desktop-settings";

export type DesktopExplorerViewMode = "icon" | "list";

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
