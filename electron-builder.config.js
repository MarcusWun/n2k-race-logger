module.exports = {
  appId: 'n2k-race-logger',
  productName: 'N2K Race Logger',
  npmRebuild: true,
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    'package.json',
  ],
  asarUnpack: [
    'node_modules/better-sqlite3/**',
    'node_modules/serialport/**',
    'node_modules/@serialport/**',
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
