// Serving rules for the bundled Monaco editor used by the Code workspace.
//
// The bundle is build output (build/build-editor.mjs → src/assets/monaco/),
// far too large to embed as a SEA asset, so packaged builds stage it as a
// plain `editor\` folder beside the exe. When the folder is absent the UI
// falls back to its plain text editor, so a missing bundle is never fatal.
import path from "node:path";
import * as sea from "node:sea";
import { appPath } from "./paths.js";

export const EDITOR_ASSET_PREFIX = "/assets/monaco/";

const EDITOR_ASSET_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2"
};

export function editorAssetDir() {
  if (sea.isSea && sea.isSea()) return path.join(path.dirname(process.execPath), "editor");
  return appPath("src", "assets", "monaco");
}

// Returns { file, type } for a request inside the bundle folder, or null when
// the request is not an editor asset, not a type we serve, or tries to escape
// the folder. Only flat names are valid; the bundle has no subdirectories.
export function resolveEditorAsset(urlPath, dir = editorAssetDir()) {
  const requested = String(urlPath || "");
  if (!requested.startsWith(EDITOR_ASSET_PREFIX)) return null;
  const name = requested.slice(EDITOR_ASSET_PREFIX.length);
  if (!name || name.includes("..") || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const type = EDITOR_ASSET_TYPES[path.extname(name).toLowerCase()];
  if (!type) return null;
  return { file: path.join(dir, name), type };
}
