import { useMemo, useState } from "react";
import { PROXY_ID } from "../constants";

export default function useProxyRunner({
  proxyEnvs = [],
  setStatuses,
  appendLog,
  setSelectedId,
  showToast,
}) {
  const [proxyEnvId, setProxyEnvId] = useState("default");
  const [proxyCustomSuffix, setProxyCustomSuffix] = useState("");

  const getProxySuffix = () => {
    const custom = proxyCustomSuffix.trim();
    if (custom) return custom;
    const env = proxyEnvs.find((e) => e.id === proxyEnvId);
    return env?.scriptSuffix ?? "";
  };

  const handleChangeCustomSuffix = (value) => {
    setProxyCustomSuffix(value);
    if (value.trim()) setProxyEnvId("");
    else setProxyEnvId(proxyEnvs[0]?.id || "default");
  };

  const handleSelectEnv = (id) => {
    setProxyEnvId(id);
    setProxyCustomSuffix("");
  };

  const handleProxyDeploy = async () => {
    const suffix = getProxySuffix();
    setStatuses((prev) => ({ ...prev, [PROXY_ID]: "starting" }));

    appendLog(PROXY_ID, "\x1b[35m══════════════════════════════\x1b[0m\n");
    appendLog(
      PROXY_ID,
      `\x1b[35m🚀 部署 koa-proxy${
        suffix ? ` (start-${suffix})` : " (start)"
      }\x1b[0m\n`,
    );
    appendLog(PROXY_ID, "\x1b[35m══════════════════════════════\x1b[0m\n");

    setSelectedId(PROXY_ID);

    const isCustom =
      suffix &&
      !proxyEnvs.find((e) => e.id === proxyEnvId && e.scriptSuffix === suffix);
    const envId = isCustom ? `__custom__:${suffix}` : proxyEnvId || "default";

    const result = await window.electronAPI.deployProxy(envId);
    if (!result.success) {
      setStatuses((prev) => ({ ...prev, [PROXY_ID]: "error" }));
      showToast?.(`部署失败: ${result.error}`, "error");
    }
  };

  const handleProxyStop = async () => {
    setStatuses((prev) => ({ ...prev, [PROXY_ID]: "stopped" }));
    const result = await window.electronAPI.stopProxy();
    showToast?.(
      result.success ? "koa-proxy 已停止" : `停止失败: ${result.error}`,
      result.success ? "success" : "error",
    );
  };

  const proxySuffix = useMemo(
    () => getProxySuffix(),
    [proxyCustomSuffix, proxyEnvId, proxyEnvs],
  );

  const proxyBadge = proxySuffix ? `start-${proxySuffix}` : "start";

  return {
    proxyEnvId,
    proxyCustomSuffix,
    proxySuffix,
    proxyBadge,
    setProxyEnvId,
    setProxyCustomSuffix,
    handleChangeCustomSuffix,
    handleSelectEnv,
    handleProxyDeploy,
    handleProxyStop,
  };
}
