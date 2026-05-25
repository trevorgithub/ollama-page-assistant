# Setting Up Caddy as a Reverse Proxy for Ollama

These instructions are for **Windows**. Caddy sits between the browser extension and Ollama,
adding bearer token authentication so that only this extension (with the correct token) can reach
Ollama. Because Caddy forwards requests as a local process, `OLLAMA_ORIGINS` does not need to be
set.

---

## 1. Download Caddy

1. Go to <https://caddyserver.com/download>
2. Select **Windows** and **amd64** (or arm64 if applicable), leave the modules list empty
3. Click **Download**
4. Rename the downloaded file to `caddy.exe`

---

## 2. Create a folder and place the files

Create a permanent home for Caddy, for example:

```
C:\tools\caddy\
```

Place `caddy.exe` in that folder.

---

## 3. Create the Caddyfile

Create a file named `Caddyfile` (no extension) in `C:\tools\caddy\` with the following content,
replacing `your-secret-token` with a strong secret of your choosing:

```
:8080 {
    @unauth not header Authorization "Bearer your-secret-token"
    respond @unauth 401

    reverse_proxy localhost:11434 {
        header_up Origin "http://localhost"
    }
}
```

> The `header_up Origin` directive rewrites the browser's `chrome-extension://` origin to
> `http://localhost` before the request reaches Ollama. This means Ollama sees the request as a
> local call and no `OLLAMA_ORIGINS` environment variable is required.

---

## 4. Test manually

Open a terminal, navigate to the folder, and run:

```cmd
cd C:\tools\caddy
caddy run
```

Caddy will log `serving initial configuration` if everything is correct. Press `Ctrl+C` to stop.

---

## 5. Configure the extension

In the extension Settings (⚙):

| Field               | Value                   |
| ------------------- | ----------------------- |
| **Server endpoint** | `http://localhost:8080` |
| **API key**         | `your-secret-token`     |

Click **Save Settings**, then click **Test** to confirm the connection.

---

## 6. Run Caddy automatically at login

### Option A — Caddy's built-in Windows Service support

Open an **elevated** (Run as Administrator) terminal and run:

```cmd
cd C:\tools\caddy
caddy service install --config C:\tools\caddy\Caddyfile
caddy service start
```

To stop and uninstall later:

```cmd
caddy service stop
caddy service uninstall
```

### Option B — Task Scheduler (no elevation required)

1. Open **Task Scheduler** and click **Create Basic Task**
2. Name it `Caddy – Ollama proxy`
3. Trigger: **When I log on**
4. Action: **Start a program**
   - Program: `C:\tools\caddy\caddy.exe`
   - Arguments: `run --config C:\tools\caddy\Caddyfile`
5. Finish the wizard, then open the task's properties and check
   **Run whether user is logged on or not** if you want it to run as a background service

---

## Choosing a token

The token can be any string — a long random value is best. You can generate one in PowerShell:

```powershell
[System.Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Use the output as both the `your-secret-token` value in the Caddyfile and the **API key** in the
extension Settings.

---

## Verifying the proxy is working

With Caddy running, test from a terminal:

```cmd
# Should return model list JSON
curl -H "Authorization: Bearer your-secret-token" http://localhost:8080/api/tags

# Should return 401
curl http://localhost:8080/api/tags
```
