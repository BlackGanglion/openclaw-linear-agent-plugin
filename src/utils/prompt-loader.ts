import { readFileSync, watch } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, string>();

/**
 * 加载 prompt 文件，启动时读取一次并缓存，文件变化时自动重新加载。
 * 多次调用同一路径只会注册一个 watcher。
 */
export function loadPrompt(relativePath: string): () => string {
  const absolutePath = join(process.cwd(), "prompts", relativePath);

  if (!cache.has(absolutePath)) {
    cache.set(absolutePath, readSync(absolutePath));

    watch(absolutePath, (eventType) => {
      if (eventType === "change") {
        cache.set(absolutePath, readSync(absolutePath));
      }
    });
  }

  return () => cache.get(absolutePath) ?? "";
}

function readSync(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
