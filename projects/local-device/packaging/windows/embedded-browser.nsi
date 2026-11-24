Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
Name "${CONNECTOR_NAME}"
OutFile "${INSTALLER_FILE}"
InstallDir "$LOCALAPPDATA\${CONNECTOR_ID}"
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section
  SetOutPath "$INSTDIR"
  File "${STAGING_DIR}/${CONNECTOR_NAME}.exe"
  File "${STAGING_DIR}/browser-native-host.exe"
  SetOutPath "$INSTDIR\browser-runtime"
  File /r "${STAGING_DIR}/browser-runtime/*"
  SetOutPath "$INSTDIR\embedded-browser"
  File /r "${STAGING_DIR}/embedded-browser/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${CONNECTOR_NAME}.lnk" "$INSTDIR\${CONNECTOR_NAME}.exe"
SectionEnd

Section "Uninstall"
  ExecWait '"$INSTDIR\${CONNECTOR_NAME}.exe" --unregister-browser chrome'
  ExecWait '"$INSTDIR\${CONNECTOR_NAME}.exe" --unregister-browser edge'
  Delete "$SMPROGRAMS\${CONNECTOR_NAME}.lnk"
  Delete "$INSTDIR\${CONNECTOR_NAME}.exe"
  Delete "$INSTDIR\browser-native-host.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\browser-runtime"
  RMDir /r "$INSTDIR\embedded-browser"
  RMDir "$INSTDIR"
SectionEnd
