export const GITHUB_OWNER = "MY_GITHUB_USERNAME";
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
      stderr: "pipe",
    },
  );

  const [stderr, exitCode] = await Promise.all([
    new Response(installer.stderr).text(),
    installer.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(
      detail
        ? `Installer exited with code ${exitCode}: ${detail}`
        : `Installer exited with code ${exitCode}.`,
    );
  }
}
