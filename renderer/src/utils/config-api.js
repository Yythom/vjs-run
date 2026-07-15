export async function loadConfig() {
  return window.electronAPI.getConfig();
}

export async function saveConfig(partial) {
  const result = await window.electronAPI.setConfig(partial);
  if (!result?.success) {
    throw new Error(result?.error || "未知错误");
  }
  return result.config;
}
