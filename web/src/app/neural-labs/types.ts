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
  restore_bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
    snapped_zone: PreviewSnapZone | null;
  } | null;
}
