const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const { join } = require("node:path");
const { writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { pathToFileURL } = require("node:url");

const isDev = process.argv.includes("--dev") || process.env.LAPIAN_DEV === "1";

// 无 GPU 的虚拟机/沙箱环境下 Chromium 会直接 FATAL 退出，提供软件渲染开关
if (process.argv.includes("--software-render") || process.env.LAPIAN_SOFTWARE_RENDER === "1") {
  app.disableHardwareAcceleration();
}

let serverHandle = null;
let mainWindow = null;

function resolvePaths() {
  const rootDir = join(__dirname, "..");
  return {
    rootDir,
    // 数据目录固定 ASCII 路径，避免第三方原生组件在中文路径下读写异常
    dataDir: join(app.getPath("appData"), "lapian-studio"),
    vendorDir: app.isPackaged ? join(process.resourcesPath, "vendor") : join(rootDir, "vendor"),
    webDir: join(rootDir, "dist"),
  };
}

async function startLocalServer() {
  const paths = resolvePaths();
  const serverEntry = join(__dirname, "..", "server", "index.mjs");
  const { startServer } = await import(pathToFileURL(serverEntry).href);
  serverHandle = await startServer({
    port: 5178,
    dataDir: paths.dataDir,
    vendorDir: paths.vendorDir,
    webDir: paths.webDir,
  });
  console.log(`[lapian] 本地服务已启动: ${serverHandle.url}`);
  return serverHandle;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#0f1115",
    title: "拉片工作台",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择分镜视频的导出目录",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "导出到此处",
    });
    return result.canceled ? "" : result.filePaths[0];
  });

  ipcMain.handle("get-downloads-dir", () => app.getPath("downloads"));

  ipcMain.handle("save-file", async (_event, fileName, content) => {
    try {
      if (typeof content !== "string" || !content) return { ok: false, error: "内容为空" };
      const safeName = String(fileName || "导出.txt").replace(/[\\/:*?"<>|]/g, "_");
      const dir = app.getPath("downloads");
      const extMatch = safeName.match(/\.[a-z0-9]{1,6}$/i);
      const ext = extMatch ? extMatch[0] : "";
      let target = join(dir, safeName);
      let index = 1;
      while (existsSync(target)) {
        target = join(dir, safeName.replace(/\.[a-z0-9]{1,6}$/i, "") + "-" + index + ext);
        index += 1;
      }
      await writeFile(target, content, "utf8");
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle("save-png", async (_event, dataUrl, fileName) => {
    try {
      const base64 = String(dataUrl || "").split(",")[1] || "";
      if (!base64) return { ok: false, error: "图片数据为空" };
      const safeName = String(fileName || "报告.png").replace(/[\\/:*?"<>|]/g, "_");
      const dir = app.getPath("downloads");
      const extMatch = safeName.match(/\.(png|jpe?g|webp)$/i);
      const ext = extMatch ? extMatch[0] : ".png";
      let target = join(dir, safeName);
      let index = 1;
      while (existsSync(target)) {
        target = join(dir, safeName.replace(/\.(png|jpe?g|webp)$/i, "") + `-${index}${ext}`);
        index += 1;
      }
      await writeFile(target, Buffer.from(base64, "base64"));
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  try {
    const server = await startLocalServer();
    createWindow(isDev ? "http://127.0.0.1:5273" : server.url);
  } catch (error) {
    dialog.showErrorBox(
      "启动失败",
      `本地服务没能启动：\n${error.message || error}\n\n如果是端口占用，请关闭其他实例后重试。`,
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
      createWindow(isDev ? "http://127.0.0.1:5273" : serverHandle.url);
    }
  });
});

app.on("window-all-closed", async () => {
  if (serverHandle) await serverHandle.close().catch(() => {});
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (serverHandle) {
    await serverHandle.close().catch(() => {});
    serverHandle = null;
  }
});
