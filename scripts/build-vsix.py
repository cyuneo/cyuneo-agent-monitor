#!/usr/bin/env python3
"""Pack the extension into cyuneo-agent-monitor-<version>.vsix (no Node or vsce needed).

  python3 scripts/build-vsix.py              -> ./cyuneo-agent-monitor-<version>.vsix
  python3 scripts/build-vsix.py --out DIR    -> DIR/cyuneo-agent-monitor-<version>.vsix

Only what the extension loads at runtime goes in (the files .vscodeignore keeps): extension.js, lib/, l10n/, media/,
package.json, package.nls*.json, LICENSE, README.md, CHANGELOG.md, THIRD_PARTY_NOTICES.md.
For the Marketplace, publish with vsce as usual; this is for installing a local build:

  code --install-extension "$PWD/cyuneo-agent-monitor-<version>.vsix"
"""

import argparse
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
TOP = ["extension.js", "package.json", "LICENSE", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"]
DIRS = ["lib", "l10n", "media"]
TYPES = {".json": "application/json", ".js": "application/javascript", ".css": "text/css", ".md": "text/markdown",
         ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".vsixmanifest": "text/xml"}


def files():
    out = [ROOT / n for n in TOP] + sorted(ROOT.glob("package.nls*.json"))
    for d in DIRS:
        out += sorted(p for p in (ROOT / d).rglob("*")
                      if p.is_file() and p.name != ".DS_Store" and p.suffix not in (".map", ".log"))
    return out


def manifest(pkg):
    icon = escape(pkg.get("icon", ""))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}"/>
    <DisplayName>{escape(pkg.get('displayName', pkg['name']))}</DisplayName>
    <Description xml:space="preserve">{escape(pkg.get('description', ''))}</Description>
    <Categories>{escape(",".join(pkg.get("categories", [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}"/>
    </Properties>
    <Icon>extension/{icon}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{icon}" Addressable="true"/>
  </Assets>
</PackageManifest>
"""


def main():
    ap = argparse.ArgumentParser(description="Build the Agent Monitor .vsix")
    ap.add_argument("--out", type=Path, default=ROOT, help="directory for the .vsix (default: the repository root)")
    a = ap.parse_args()
    pkg = json.loads((ROOT / "package.json").read_text("utf-8"))
    a.out.mkdir(parents=True, exist_ok=True)
    out = a.out / f"{pkg['name']}-{pkg['version']}.vsix"
    entries = files()
    exts = sorted({p.suffix for p in entries if p.suffix} | {".vsixmanifest"})
    types = "".join(f'<Default Extension="{e}" ContentType="{TYPES.get(e, "application/octet-stream")}"/>' for e in exts)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="utf-8"?>\n'
                   f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{types}</Types>')
        z.writestr("extension.vsixmanifest", manifest(pkg))
        for p in entries:
            z.write(p, "extension/" + p.relative_to(ROOT).as_posix())
    print(out)


if __name__ == "__main__":
    main()
