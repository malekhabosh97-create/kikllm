// Some installations replace Electron's default app with a copied application.
// Keep that launcher pointing at the checked-out sources instead of stale copies.
const fs=require("node:fs");
const path=require("node:path");
const resources=path.join(path.dirname(require("electron")),"resources");
const embedded=path.join(resources,"app");
if(fs.existsSync(embedded)){
  const main=path.join(embedded,"main.cjs");
  if(fs.existsSync(main)&&!fs.existsSync(main+".legacy"))fs.copyFileSync(main,main+".legacy");
  fs.writeFileSync(main,"process.env.FREELLM_REPO_ROOT ||= "+JSON.stringify(path.resolve(__dirname,"../.."))+";\nrequire(process.env.FREELLM_REPO_ROOT + '/packages/desktop/main.cjs');\n");
}
