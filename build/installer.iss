; Inno Setup script for Boolean - per-user install (no admin needed),
; adds the app to PATH, creates Start-menu entry, full uninstaller.
; Build:  ISCC.exe build\installer.iss

#define AppName "Boolean"
#define AppVersion "0.9.38"
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
procedure StopBooleanProcesses(IncludeApp: Boolean);
var
  ResultCode: Integer;
  Script: string;
begin
  Exec('taskkill.exe', '/F /T /IM saz.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM saz-core.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM Boolean.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM Boolean-core.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM llama-server.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Script :=
    '$roots=@(' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\Boolean'',' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\LocalLM'',' +
    '[Environment]::GetFolderPath(''LocalApplicationData'') + ''\Programs\Saz''' +
    '); ';
  if IncludeApp then
    Script := Script + '$roots += ''' + ExpandConstant('{app}') + '''; ';
  Script := Script +
    'for($i=0;$i -lt 24;$i++){ ' +
    '$procs=Get-Process Boolean,Boolean-core,saz,saz-core,llama-server -ErrorAction SilentlyContinue | Where-Object { ' +
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
