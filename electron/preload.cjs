const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lapian", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** 打开系统目录选择框，返回绝对路径；取消返回空串。 */
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  /** 弹出保存对话框并把 dataURL 写成图片文件。 */
  savePng: (dataUrl, fileName) => ipcRenderer.invoke("save-png", dataUrl, fileName),
  /** 系统下载目录（分镜视频片段默认落这里）。 */
  getDownloadsDir: () => ipcRenderer.invoke("get-downloads-dir"),
  /** 把文本内容写成文件（CSV / JSON 等）。 */
  saveFile: (fileName, content) => ipcRenderer.invoke("save-file", fileName, content),
  /** 打开语音模型目录（模型不随安装包分发，需用户手动放入）。 */
  openModelDir: () => ipcRenderer.invoke("open-model-dir"),
});
