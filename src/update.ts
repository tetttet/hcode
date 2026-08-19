export const GITHUB_OWNER = "tetttet";
export const GITHUB_REPO = "hcode";

const INSTALLER_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/install.sh`;
const INSTALL_COMMAND = `curl -fsSL ${INSTALLER_URL} | sh`;

export async function installLatestHcode(): Promise<void> {
  const installer = Bun.spawn(
    ["bash", "-o", "pipefail", "-c", INSTALL_COMMAND],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const exitCode = await installer.exited;

  if (exitCode !== 0) {
    throw new Error(`Installer exited with code ${exitCode}.`);
  }
}
