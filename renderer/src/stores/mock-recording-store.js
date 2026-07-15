import { create } from "zustand";

/**
 * Mock 录制状态 store。主进程在开始/停止/新录到一条时推送 mock-recording 事件；
 * 面板打开时通过 loadMockRecording 拉一次兜底（覆盖窗口刷新的场景）。
 */

const useMockRecordingStore = create(() => ({
  recording: { enabled: false },
}));

export const useMockRecording = () =>
  useMockRecordingStore((s) => s.recording);

export async function loadMockRecording() {
  const result = await window.electronAPI.getMockRecording();
  if (result?.success) {
    useMockRecordingStore.setState({
      recording: result.recording || { enabled: false },
    });
  }
  return result;
}

export async function startMockRecording(name) {
  const result = await window.electronAPI.startMockRecording(name);
  if (result?.success) {
    useMockRecordingStore.setState({
      recording: result.recording || { enabled: false },
    });
  }
  return result;
}

export async function stopMockRecording() {
  const result = await window.electronAPI.stopMockRecording();
  if (result?.success) {
    useMockRecordingStore.setState({ recording: { enabled: false } });
  }
  return result;
}

// ─── IPC 接线（模块首次 import 时执行一次，防 HMR 重复 attach）──────────────────
if (
  typeof window !== "undefined" &&
  window.electronAPI?.onMockRecording &&
  !window.__MOCK_RECORDING_WIRED__
) {
  window.electronAPI.onMockRecording((status) => {
    useMockRecordingStore.setState({
      recording: status || { enabled: false },
    });
  });
  window.__MOCK_RECORDING_WIRED__ = true;
}
