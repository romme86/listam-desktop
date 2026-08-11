; Inno Setup script for the Listam Windows appling.
;
; Why an installer rather than shipping Listam.exe on its own: libpear loads
; its boot splash from <exe>\..\splash.png, so the executable is not actually
; self-contained. Handing users a zip made that their problem ("keep these two
; files together"); an installer makes it an implementation detail.
;
; It also strips the mark-of-the-web from the app binary. Only the downloaded
; installer trips SmartScreen; files it writes do not carry MotW, so the
; installed Listam.exe launches without a prompt afterwards.
;
; Per-user install by design (PrivilegesRequired=lowest): no UAC prompt, and it
; lands in %LOCALAPPDATA%\Programs where the app can always write. Requires
; ISCC.exe (choco install innosetup); driven by installer/build-windows.ps1.
;
; Version and payload directory come from the build script:
;   ISCC /DListamVersion=0.19.13 /DPayloadDir=<dir> listam.iss

#ifndef ListamVersion
  #define ListamVersion "0.0.0"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\dist\stage-win32-x64"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
; Stable across releases — changing it would orphan existing installs and make
; upgrades install alongside the old copy instead of replacing it.
AppId={{7C6F9E4A-2B31-4D8E-9F5C-1A0E3D7B62F4}
AppName=Listam
AppVersion={#ListamVersion}
AppVerName=Listam {#ListamVersion}
AppPublisher=SayNode
AppPublisherURL=https://listam.ch
AppSupportURL=https://listam.ch
AppUpdatesURL=https://listam.ch/downloads
VersionInfoVersion={#ListamVersion}
VersionInfoCompany=SayNode
VersionInfoDescription=Listam installer
VersionInfoProductName=Listam

DefaultDirName={autopf}\Listam
DefaultGroupName=Listam
DisableProgramGroupPage=yes
DisableDirPage=auto
AllowNoIcons=yes

; Per-user: no administrator prompt, and %LOCALAPPDATA%\Programs stays writable
; for the app itself. Nothing here needs machine-wide access.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

OutputDir={#OutputDir}
OutputBaseFilename=Listam-Setup-{#ListamVersion}-win32-x64
SetupIconFile=..\appling\assets\win32\icon.ico
UninstallDisplayIcon={app}\Listam.exe
UninstallDisplayName=Listam {#ListamVersion}

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\Listam.exe";  DestDir: "{app}"; Flags: ignoreversion
; Not optional: libpear reads this while the app bootstraps.
Source: "{#PayloadDir}\splash.png"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Listam"; Filename: "{app}\Listam.exe"
Name: "{group}\{cm:UninstallProgram,Listam}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Listam"; Filename: "{app}\Listam.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Listam.exe"; Description: "{cm:LaunchProgram,Listam}"; Flags: nowait postinstall skipifsilent

; No [UninstallDelete]. Uninstalling removes the app, never the user's lists:
; those live in the Pear storage under %APPDATA%, shared with the Pear runtime
; and any other Pear app, so removing them here would destroy data the
; uninstaller does not own.
