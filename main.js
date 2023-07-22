// can add mods with `curl http://localhost:3000/add-mod/447188`


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
const { createExtractorFromFile  } = require('node-unrar-js');

const express = require('express');
const express_server = express();
const port = 3000;

express_server.get('/add-mod/:modId', (req, res) => {
  const modId = req.params.modId;
  // Here you can do something with the modId

  // send the modId to the renderer process
  mainWindow.webContents.send('add-mod', modId);

  res.send('Received modId: ' + modId);
});

express_server.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});


app.on('ready', createWindow)

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
  if (mainWindow === null) createWindow()
})


let mainWindow

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: true,
      preload: path.join(__dirname, 'preload.js'),
    //   contextIsolation: false,
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



ipcMain.on('download-and-unzip', async (event, url, modFolder, modName) => {
    const tmpfile = await tmp.file();
  
    const response = await axios.get(url, { responseType: 'stream' });

    // Download the file
    await streamPipeline(response.data, fs.createWriteStream(tmpfile.path));

    const modNameWithoutExtension = modName.slice(0, modName.lastIndexOf('.'));
    const extractedFolderPath = path.join(modFolder, modNameWithoutExtension);
    fs.ensureDirSync(extractedFolderPath);

    // Depending on the file extension, use either ZIP or RAR extraction
    const extension = path.extname(modName).toLowerCase();
    if (extension === '.zip') {
        const zip = new AdmZip(tmpfile.path);
        zip.extractAllTo(/*true to overwrite files*/extractedFolderPath, true);
    } else if (extension === '.rar') {
      const extractor = await createExtractorFromFile({
        filepath: tmpfile.path,
        targetPath: extractedFolderPath
      });
      [...extractor.extract().files];
    }

    const moveContentsToTarget = (sourceDir, targetDir) => {
        const files = fs.readdirSync(sourceDir);
        files.forEach((file) => {
            const oldPath = path.join(sourceDir, file);
            const newPath = path.join(targetDir, file);
            fs.renameSync(oldPath, newPath);
        });
    }

    const findAndMove = (currentDir) => {
        const files = fs.readdirSync(currentDir);
        files.forEach((file) => {
            const currentPath = path.join(currentDir, file);
            if (fs.lstatSync(currentPath).isDirectory()) {
                if (file === 'romfs' || file === 'exefs') {
                    const parentDir = path.dirname(currentPath);
                    moveContentsToTarget(parentDir, path.join(modFolder, modNameWithoutExtension));
                    if (fs.readdirSync(parentDir).length === 0) {
                        fs.removeSync(parentDir); // Remove the top folder only if it's empty
                    }
                } else {
                    findAndMove(currentPath);
                }
            }
        });
    }

    findAndMove(extractedFolderPath);

    console.log(`File downloaded to: ${extractedFolderPath}`);

    await tmpfile.cleanup();
});



