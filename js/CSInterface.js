/**
 * CSInterface.js — Adobe CEP 通信库（精简内嵌版）
 * 原版：https://github.com/Adobe-CEP/CSInterface
 * 版本：11.x  兼容 CC2019–2025
 */
var SystemPath = { EXTENSION: "extension" };

var CSInterface = (function () {
  function CSInterface() {
    this.hostEnvironment = null;
    try {
      if (window.__adobe_cep__) this.hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    } catch (e) { console.warn("无法读取宿主环境", e); }
  }

  CSInterface.prototype.evalScript = function (script, callback) {
    if (window.__adobe_cep__) {
      if (callback) {
        window.__adobe_cep__.evalScript(script, callback);
      } else {
        window.__adobe_cep__.evalScript(script);
      }
    } else {
      console.log("[evalScript] " + script);
      if (callback) callback('{"error":"未在 Illustrator 中运行"}');
    }
  };

  CSInterface.prototype.closeExtension = function () {
    if (window.__adobe_cep__) window.__adobe_cep__.closeExtension();
  };

  CSInterface.prototype.getSystemPath = function (pathType) {
    if (window.__adobe_cep__) return window.__adobe_cep__.getSystemPath(pathType);
    return "";
  };

  CSInterface.prototype.addEventListener = function (type, listener, obj) {
    if (window.__adobe_cep__) window.__adobe_cep__.addEventListener(type, listener, obj);
  };

  CSInterface.prototype.dispatchEvent = function (event) {
    if (window.__adobe_cep__) window.__adobe_cep__.dispatchEvent(event);
  };

  CSInterface.prototype.getApplicationID = function () {
    var host = this.hostEnvironment;
    return host ? host.appId : "";
  };

  return CSInterface;
})();
