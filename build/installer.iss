; Inno Setup script for Boolean - per-user install (no admin needed),
; adds the app to PATH, creates Start-menu entry, full uninstaller.
; Build:  ISCC.exe build\installer.iss

#define AppName "Boolean"
#define AppVersion "0.9.62"
#define AppPublisher "saz3 Labs"
#define AppExe "Boolean.exe"
#define CoreExe "Boolean-core.exe"

[Setup]
AppId={{3D9A7B42-C1E6-4F8A-9B2D-E5F0A3C81D67}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={userpf}\{#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Boolean-setup
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
UninstallDisplayName={#AppName} - local AI workspace
WizardStyle=modern
SetupIconFile=..\assets\saz.ico
UninstallDisplayIcon={app}\{#AppExe}
LicenseFile=..\assets\LICENSE.txt

[Files]
; the whole native-shell distribution (Boolean.exe shell + Boolean-core.exe backend +
; engine + templates + docs), produced by build\build-shell.ps1
Source: "..\dist\saz-app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Small Microsoft bootstrapper. It downloads the architecture-matched Evergreen
; WebView2 Runtime only on PCs where the Runtime is missing (notably some Win10 PCs).
Source: "..\dist\prerequisites\MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy

[InstallDelete]
; Remove executables and shortcuts left by the temporary Boollm product name.
; Keeping these beside the restored Boolean app can launch an older build.
Type: files; Name: "{app}\Boollm.exe"
Type: files; Name: "{app}\Boollm-core.exe"
Type: files; Name: "{userprograms}\Boollm.lnk"
Type: files; Name: "{userprograms}\Boollm (terminal).lnk"
Type: files; Name: "{userdesktop}\Boollm.lnk"

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\saz.ico"; WorkingDir: "{app}"
Name: "{userprograms}\{#AppName} (terminal)"; Filename: "{app}\{#CoreExe}"; IconFilename: "{app}\saz.ico"; WorkingDir: "{userdocs}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\saz.ico"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"

[Registry]
; add install dir to the user PATH so Boolean-core works in any terminal
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName} now"; \
  Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2Version(RootKey: Integer; Subkey: string): Boolean;
var
  Version: string;
begin
  Result :=
    RegQueryStringValue(RootKey, Subkey, 'pv', Version) and
    (Version <> '') and
    (Version <> '0.0.0.0');
end;

function IsWebView2Installed(): Boolean;
var
  UserKey: string;
  MachineKey: string;
begin
  UserKey := 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid;
  MachineKey := 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid;
  Result :=
    HasWebView2Version(HKCU, UserKey) or
    HasWebView2Version(HKLM32, MachineKey);
  if IsWin64 then
    Result := Result or HasWebView2Version(HKLM64, MachineKey);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ResultCode: Integer;
  Bootstrapper: string;
begin
  Result := '';
  if IsWebView2Installed() then
    exit;

  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  Bootstrapper := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
  WizardForm.StatusLabel.Caption :=
    'Installing the Microsoft WebView2 Runtime required by Boolean...';

  if not Exec(Bootstrapper, '/silent /install', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
  begin
    Result :=
      'Boolean needs the Microsoft Edge WebView2 Runtime, but setup could not ' +
      'start the Microsoft installer. Check your internet connection and try again.';
    exit;
  end;

  if (ResultCode <> 0) or (not IsWebView2Installed()) then
    Result :=
      'Microsoft Edge WebView2 Runtime could not be installed (error ' +
      IntToStr(ResultCode) + '). Check your internet connection or ask your PC ' +
      'administrator to allow WebView2, then run Boolean setup again.';
end;

procedure StopBooleanProcesses(IncludeApp: Boolean);
var
  ResultCode: Integer;
  Script: string;
begin
  Exec('taskkill.exe', '/F /T /IM saz.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM saz-core.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM Boolean.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM Boolean-core.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM Boolean.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM Boolean-core.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM llama-server.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Script :=
    '$roots=@(' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\Boolean'',' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\Boolean'',' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\LocalLM'',' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\Saz''' +
    '); ';
  if IncludeApp then
    Script := Script + '$roots += ''' + ExpandConstant('{app}') + '''; ';
  Script := Script +
    'for($i=0;$i -lt 24;$i++){ ' +
    '$procs=Get-Process Boolean,Boolean-core,Boolean,Boolean-core,saz,saz-core,llama-server -ErrorAction SilentlyContinue | Where-Object { ' +
    'try{$p=$_.Path}catch{$p=$null}; ' +
    '$p -and ($roots | Where-Object { $p.StartsWith($_,[StringComparison]::OrdinalIgnoreCase) }) ' +
    '}; ' +
    'if(-not $procs){break}; ' +
    '$procs | Stop-Process -Force -ErrorAction SilentlyContinue; ' +
    'Start-Sleep -Milliseconds 500 ' +
    '}';
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -Command "' + Script + '"', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function InitializeSetup(): Boolean;
begin
  StopBooleanProcesses(False);
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    StopBooleanProcesses(True);
end;

function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

procedure RemovePath(Dir: string);
var
  Path: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then
    exit;
  P := Pos(';' + Uppercase(Dir), ';' + Uppercase(Path));
  if P = 0 then
    exit;
  Delete(Path, P, Length(Dir) + 1);
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopBooleanProcesses(True);
  if CurUninstallStep = usPostUninstall then
    RemovePath(ExpandConstant('{app}'));
end;
