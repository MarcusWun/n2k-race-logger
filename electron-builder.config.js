module.exports = {
  appId: 'n2k-race-logger',
  productName: 'N2K Race Logger',
  npmRebuild: false,
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    'package.json',
  ],
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};
