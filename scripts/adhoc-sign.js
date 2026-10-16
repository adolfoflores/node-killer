// electron-builder afterPack hook.
// Without a Developer ID certificate electron-builder skips signing, which leaves the
// app with a broken signature (the binary is signed but the bundle is not sealed), and
// macOS reports a downloaded copy as "damaged". An ad-hoc signature over the whole
// bundle is valid, so macOS only asks for confirmation on first launch instead.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
