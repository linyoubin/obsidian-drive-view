/**
 * VaultMounter 单测共用假宿主（0.2.21）。
 *
 * 不 import `obsidian` 运行时：fileMap / onChange / getAbstractFileByPath 用结构等价实现。
 * 本地磁盘用「扁平路径表」描述，`list` 按父路径过滤，`stat` 计数便于断言。
 */

export interface FakeNode {
  path: string;
  children?: FakeNode[];
  stat?: { ctime: number; mtime: number; size: number };
}

export interface LocalTree {
  /** 文件夹完整路径（不含根 ""）。 */
  folders: string[];
  /** 文件完整路径 → 字节数。 */
  files: Record<string, number>;
}

export interface HarnessOptions {
  local?: LocalTree;
  cloud?: Array<{
    path: string;
    type: "file" | "folder";
    ctime?: number;
    mtime?: number;
    size?: number;
  }>;
  configDir?: string;
}

export interface VaultHarness {
  app: unknown;
  fileMap: Record<string, FakeNode>;
  localAdapter: Record<string, unknown>;
  cloudAdapter: Record<string, unknown>;
  mountable: { createProxiedAdapter(): unknown; cache: { getAllEntries(): unknown[] } };
  stats: {
    stops: number;
    starts: number;
    listCalls: string[];
    statCalls: string[];
    events: string[];
  };
  setAdapter(value: unknown): void;
  currentAdapter(): unknown;
}

export const DEFAULT_LOCAL_TREE: LocalTree = {
  folders: ["notes"],
  files: { "local.md": 11, "notes/local2.md": 22 },
};

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function makeVaultHarness(options: HarnessOptions = {}): VaultHarness {
  const local = options.local ?? DEFAULT_LOCAL_TREE;
  const configDir = options.configDir ?? ".obsidian";
  const cloud = options.cloud ?? [
    { path: "cloud", type: "folder", ctime: 10, mtime: 10, size: 0 },
    { path: "cloud/a.md", type: "file", ctime: 11, mtime: 12, size: 13 },
  ];

  const stats = { stops: 0, starts: 0, listCalls: [] as string[], statCalls: [] as string[], events: [] as string[] };
  const fileMap: Record<string, FakeNode> = {};
  let current: unknown = null;

  const vault = {
    configDir,
    get adapter() {
      return current;
    },
    set adapter(value: unknown) {
      current = value;
    },
    fileMap,
    getAbstractFileByPath: (path: string) => fileMap[path] ?? null,
    onChange: (
      type: string,
      path: string,
      oldPath?: string,
      stat?: { ctime: number; mtime: number; size: number }
    ) => {
      stats.events.push(`${type}:${path}`);
      if (type === "folder-created") {
        fileMap[path] = { path, children: [] };
        return;
      }
      if (type === "file-created" || type === "raw") {
        fileMap[path] = fileMap[path] ?? { path };
        if (stat) fileMap[path].stat = stat;
        return;
      }
      if (type === "modified") {
        fileMap[path] = fileMap[path] ?? { path };
        return;
      }
      if (type === "file-removed" || type === "folder-removed") {
        delete fileMap[path];
        return;
      }
      if (type === "renamed" && oldPath) {
        const node = fileMap[oldPath];
        delete fileMap[oldPath];
        if (node) {
          node.path = path;
          fileMap[path] = node;
        }
      }
    },
  };

  const localAdapter: Record<string, unknown> = {
    getName: () => "FileSystemAdapter",
    stopWatch: async () => {
      stats.stops += 1;
    },
    startWatch: () => {
      stats.starts += 1;
    },
    read: async () => "",
    list: async (path: string) => {
      stats.listCalls.push(path);
      const folders = local.folders.filter((folder) => parentOf(folder) === path);
      const files = Object.keys(local.files).filter((file) => parentOf(file) === path);
      return { files, folders };
    },
    stat: async (path: string) => {
      stats.statCalls.push(path);
      const size = local.files[path];
      return size !== undefined
        ? { type: "file" as const, ctime: 1, mtime: 2, size }
        : { type: "file" as const, ctime: 1, mtime: 2, size: 0 };
    },
  };

  const cloudAdapter: Record<string, unknown> = {
    getName: () => "quark",
    read: async () => "",
    list: async () => ({ files: [], folders: [] }),
    stat: async () => null,
  };

  const mountable = {
    createProxiedAdapter: () => cloudAdapter,
    cache: { getAllEntries: () => cloud.map((entry) => ({ ...entry })) },
  };

  const app = {
    vault,
    metadataCache: {},
    workspace: { getLeavesOfType: () => [] },
  };

  current = localAdapter;

  return {
    app,
    fileMap,
    localAdapter,
    cloudAdapter,
    mountable,
    stats,
    setAdapter: (value) => {
      current = value;
    },
    currentAdapter: () => current,
  };
}

/** 按本地树预置挂载前的 fileMap（路径集合与磁盘一致）。 */
export function seedLocalFileMap(harness: VaultHarness, local: LocalTree): void {
  const vault = (harness.app as { vault: { onChange: (type: string, path: string) => void } }).vault;
  const folders = ["/", ...local.folders].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const folder of folders) vault.onChange("folder-created", folder);
  for (const file of Object.keys(local.files)) vault.onChange("raw", file);
}

export function sortedPaths(harness: VaultHarness): string[] {
  return Object.keys(harness.fileMap).sort();
}
