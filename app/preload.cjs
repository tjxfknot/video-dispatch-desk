'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args).catch(error => {
  const raw=typeof error?.message==='string'?error.message:'操作未完成，请重试。';
  throw new Error(raw.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/,'').trim());
});

contextBridge.exposeInMainWorld('publisher', Object.freeze({
  bootstrap: invoke('desk:bootstrap'),
  chooseAsset: invoke('desk:choose-asset'),
  chooseAssetsBatch: invoke('desk:choose-assets-batch'),
  chooseAssetFolder: invoke('desk:choose-asset-folder'),
  importAssetPaths: invoke('desk:import-asset-paths'),
  swapCovers: invoke('desk:swap-covers'),
  loadCommonTags: invoke('desk:load-common-tags'),
  saveCommonTags: invoke('desk:save-common-tags'),
  getPathForFile(file) {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function' ? String(webUtils.getPathForFile(file) || '') : '';
    } catch {
      return '';
    }
  },
  saveDraft: invoke('desk:save-draft'),
  saveAccount: invoke('desk:save-account'),
  saveTeacher: invoke('desk:save-teacher'),
  saveTeacherProfile: invoke('desk:save-teacher-profile'),
  reportTeacherForm: invoke('desk:report-teacher-form'),
  saveManagedAccount: invoke('desk:save-managed-account'),
  startAccountPair: invoke('desk:start-account-pair'),
  cancelAccountPair: invoke('desk:cancel-account-pair'),
  confirmAccountPair: invoke('desk:confirm-account-pair'),
  inspectManagedAccount: invoke('desk:inspect-managed-account'),
  openManagedAccount: invoke('desk:open-managed-account'),
  unbindManagedAccount: invoke('desk:unbind-managed-account'),
  openAccountBrowser: invoke('desk:open-account-browser'),
  confirmBrowserAccount: invoke('desk:confirm-browser-account'),
  closeAccountBrowser: invoke('desk:close-account-browser'),
  cancelBrowserBinding: invoke('desk:cancel-browser-binding'),
  checkAccountReadiness: invoke('desk:check-account-readiness'),
  saveTemplate: invoke('desk:save-template'),
  validate: invoke('desk:validate'),
  startRun: invoke('desk:start-run'),
  reviewManagedPilot: invoke('desk:review-managed-pilot'),
  startManagedPilot: invoke('desk:start-managed-pilot'),
  approveManagedPilot: invoke('desk:approve-managed-pilot'),
  inspectManagedResult: invoke('desk:inspect-managed-result'),
  listPreparationTests: invoke('desk:list-preparation-tests'),
  reviewPreparationTest: invoke('desk:review-preparation-test'),
  startPreparationTest: invoke('desk:start-preparation-test'),
  readPreparationLocation: invoke('desk:read-preparation-location'),
  stopPreparationTest: invoke('desk:stop-preparation-test'),
  openPublishedWork: invoke('desk:open-published-work'),
  cancelRun: invoke('desk:cancel-run'),
  connectAccount: invoke('desk:connect-account'),
  inspectAccount: invoke('desk:inspect-account'),
  closeAccountWindow: invoke('desk:close-account-window'),
  startChromePair: invoke('desk:start-chrome-pair'),
  stopChromePair: invoke('desk:stop-chrome-pair'),
  startChromePrepare: invoke('desk:start-chrome-prepare'),
  stopChromePrepare: invoke('desk:stop-chrome-prepare'),
  authorizeChromePublish: invoke('desk:authorize-chrome-publish'),
  exportRun: invoke('desk:export-run'),
  openCreator: invoke('desk:open-creator'),
  onUpdate(callback) {
    if (typeof callback !== 'function') throw new Error('监听函数无效。');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('desk:update', listener);
    return () => ipcRenderer.removeListener('desk:update', listener);
  }
}));
