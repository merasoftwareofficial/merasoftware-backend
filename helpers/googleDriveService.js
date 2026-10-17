const { google } = require('googleapis');
const { Readable } = require('stream');
const { measureUpload } = require('./uploadTiming');
const { runDriveUpload } = require('./uploadConcurrency');

const folderCache = new Map();
const clientCache = new Map();
const FOLDER_TTL_MS = 5 * 60 * 1000;

class GoogleDriveService {
  constructor(keyFilePath, folderName, timing) {
    this.keyFilePath = keyFilePath;
    this.folderName = folderName;
    this.timing = timing;
    this.driveClient = this.createDriveClient();
  }

  createDriveClient() {
    const cached = clientCache.get(this.keyFilePath);
    if (cached && cached.expires > Date.now()) return cached.client;
    const auth = new google.auth.GoogleAuth({
      keyFile: this.keyFilePath,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
   
    const client = google.drive({ version: 'v3', auth });
    if (clientCache.size >= 16) clientCache.delete(clientCache.keys().next().value);
    clientCache.set(this.keyFilePath, { client, expires: Date.now() + FOLDER_TTL_MS });
    return client;
  }

  // Create folder in Google Drive if it doesn't exist
  async createFolder() {
    const key = `${this.keyFilePath}:${this.folderName}`;
    const cached = folderCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    if (folderCache.size >= 32) folderCache.delete(folderCache.keys().next().value);
    const promise = runDriveUpload(() => this.findOrCreateFolder());
    folderCache.set(key, { promise, expires: Date.now() + FOLDER_TTL_MS });
    try { return await promise; }
    catch (error) { if (folderCache.get(key)?.promise === promise) folderCache.delete(key); throw error; }
  }

  invalidateFolder() {
    folderCache.delete(`${this.keyFilePath}:${this.folderName}`);
  }

  async findOrCreateFolder() {
    try {
      console.log(`Looking for folder: ${this.folderName}`);
      
      // Check if folder already exists
      const response = await measureUpload(this.timing, 'drive_folder_lookup', () => this.driveClient.files.list({
        q: `name='${this.folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)'
      }));
      
      console.log(`Found ${response.data.files.length} matching folders`);
      
      if (response.data.files.length > 0) {
        // Folder exists, return the ID
        console.log(`Using existing folder: ${response.data.files[0].name} (${response.data.files[0].id})`);
        return response.data.files[0].id;
      }
      
      // Folder doesn't exist, create it
      console.log(`Creating new folder: ${this.folderName}`);
      const fileMetadata = {
        name: this.folderName,
        mimeType: 'application/vnd.google-apps.folder'
      };
      
      const newFolder = await measureUpload(this.timing, 'drive_folder_create', () => this.driveClient.files.create({
        resource: fileMetadata,
        fields: 'id'
      }));
      
      console.log(`Created folder with ID: ${newFolder.data.id}`);
      
      // Make the folder public so links will work
      await measureUpload(this.timing, 'drive_folder_permission', () => this.driveClient.permissions.create({
        fileId: newFolder.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      }));
      
      console.log(`Set public permissions on folder: ${newFolder.data.id}`);
      
      return newFolder.data.id;
    } catch (error) {
      console.error('Error creating folder:', error.message);
      if (error.response) {
        console.error('Response error details:', error.response.data);
      }
      throw error;
    }
  }

  // Upload file to Google Drive
  async uploadFile(fileName, fileBuffer, mimeType, folderId, shouldStop = () => false) {
    return runDriveUpload(async () => {
      if (shouldStop()) return null;
      return this.uploadFileNow(fileName, fileBuffer, mimeType, folderId);
    });
  }

  async uploadFileNow(fileName, fileBuffer, mimeType, folderId) {
    let createdFileId = null;
    try {
      console.log(`Starting upload for file: ${fileName}`);
      
      const fileMetadata = {
        name: fileName,
        parents: [folderId]
      };
      
      const media = {
        mimeType,
        body: Readable.from(fileBuffer)
      };
      
      console.log(`Uploading file to Google Drive in folder: ${folderId}`);
      const response = await measureUpload(this.timing, 'drive_file_upload', () => this.driveClient.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id,name,webViewLink'
      }), { bytes: fileBuffer.length });
      createdFileId = response.data.id;
      
      console.log(`File uploaded with ID: ${response.data.id}`);
      
      // Set public permissions so anyone with the link can view
      console.log(`Setting public permissions for file: ${response.data.id}`);
      await measureUpload(this.timing, 'drive_file_permission', () => this.driveClient.permissions.create({
        fileId: response.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      }));
      
      // For images, create an embedable link
      let embedLink = null;
      if (mimeType && mimeType.startsWith('image/')) {
        embedLink = `https://drive.google.com/uc?export=view&id=${response.data.id}`;
        console.log(`Created embed link for image: ${embedLink}`);
      }
      
      return {
        id: response.data.id,
        name: response.data.name,
        link: response.data.webViewLink,
        embedLink: embedLink
      };
    } catch (error) {
      if (Number(error.code || error.response?.status) === 404) this.invalidateFolder();
      if (createdFileId) {
        await this.driveClient.files.delete({ fileId: createdFileId }).catch((cleanupError) => {
          error.uploadCleanupFailed = true;
          console.error('Error cleaning up incomplete Drive upload:', cleanupError.message);
        });
      }
      console.error('Error uploading file:', error.message);
      if (error.response) {
        console.error('Response error details:', error.response.data);
      }
      throw error;
    }
  }

  // Delete file from Google Drive
  async deleteFile(fileId) {
    try {
      await runDriveUpload(() => this.driveClient.files.delete({
        fileId
      }));
      return true;
    } catch (error) {
      if (Number(error.code || error.response?.status) === 404) return true;
      console.error('Error deleting file:', error);
      throw error;
    }
  }

  // Read a file's bytes back out of Drive as a stream.
  //
  // The service could upload, delete and list, but never read — so nothing on the server
  // could touch a file a customer had sent. Anything that needs the actual bytes (the ZIP
  // download) goes through here rather than building its own Drive client, which is what
  // the old app's downloadAllFiles.js did.
  //
  // The existing 'auth/drive' scope already permits reads; no new permission is needed.
  async getFileStream(fileId) {
    try {
      const response = await this.driveClient.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      return response.data;
    } catch (error) {
      console.error('Error reading file from Drive:', error.message);
      throw error;
    }
  }

  // List files from a specific folder
  async listFiles(folderId) {
    try {
      const response = await this.driveClient.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, webViewLink, createdTime)'
      });
      return response.data.files;
    } catch (error) {
      console.error('Error listing files:', error);
      throw error;
    }
  }

  // Set expiration time for a file (by scheduling deletion)
  async scheduleFileDeletion(fileId, expirationDays) {
    // This method would typically be used with a job scheduler
    // For demonstration purposes, we're just calculating the deletion date
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + expirationDays);
   
    // In a real application, you would store this information in your database
    // and use a job scheduler like node-cron to delete files when they expire
    return {
      fileId,
      deletionDate
    };
  }
  
  // Get a direct download link for a file
  getDownloadLink(fileId) {
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  
  // Get an embedable link for images
  getEmbedableImageLink(fileId) {
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }

  // Get an embedable link for documents (PDF, DOC, etc.)
getEmbedableDocumentLink(fileId) {
  return `https://drive.google.com/file/d/${fileId}/preview`;
  }
}

module.exports = GoogleDriveService;
