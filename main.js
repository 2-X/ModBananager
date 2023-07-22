// main.js
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const { pipeline } = require('stream');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const https = require('https');
const path = require('path');
const streamPipeline = promisify(pipeline);
const tmp = require('tmp-promise');
const url = require('url');
const axios = require('axios');


let mainWindow

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  })

  mainWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, 'index.html'),
      protocol: 'file:',
      slashes: true,
    })
  )

//   if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
//   }

  mainWindow.on('closed', function () {
    mainWindow = null
  })
}

app.on('ready', createWindow)

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
  if (mainWindow === null) createWindow()
})

app.setAsDefaultProtocolClient('my-app')

app.on('open-url', function (event, url) {
  event.preventDefault()
  // Here you can parse the url argument to get the mod URL and do something with it
})
const moveFiles = (srcDir, destDir) => {
    if (fs.existsSync(srcDir)) {
        fs.readdirSync(srcDir).forEach((file) => {
            const currentPath = path.join(srcDir, file);
            if (fs.lstatSync(currentPath).isDirectory()) {
                moveFiles(currentPath, destDir);
            } else {
                fs.renameSync(currentPath, path.join(destDir, file));
            }
        });
    }
};

ipcMain.on('download-and-unzip', async (event, url, modFolder, modName) => {
    // Create a temporary file for the download
    const tmpfile = await tmp.file();
    
    const response = await axios.get(url, { responseType: 'stream' });
  
    // Download the file
    await streamPipeline(response.data, fs.createWriteStream(tmpfile.path));
  
    const zip = new AdmZip(tmpfile.path);
  
    const extractedFolderPath = path.join(modFolder, modName.slice(0, modName.lastIndexOf('.zip')));
    fs.ensureDirSync(extractedFolderPath);
  
    zip.extractAllTo(extractedFolderPath, true);
  
    // Search for the romfs and exefs directories, move them under modFolder/modName and remove extra directories
    const files = fs.readdirSync(extractedFolderPath);
    files.forEach((file) => {
      const currentPath = path.join(extractedFolderPath, file);
      if (fs.lstatSync(currentPath).isDirectory()) {
        if (file === 'romfs' || file === 'exefs') {
          const destPath = path.join(modFolder, modName.slice(0, modName.lastIndexOf('.zip')), file);
          fs.ensureDirSync(destPath);
          moveFiles(currentPath, destPath);
        } else {
          fs.rmdirSync(currentPath, { recursive: true });
        }
      }
    });
  
    // Remove the temporary zip file
    await tmpfile.cleanup();
  });