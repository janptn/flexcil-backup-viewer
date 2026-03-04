using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace FlexcilLocalViewerGuiWrapper
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }

    internal sealed class LauncherForm : Form
    {
        private const string Url = "http://127.0.0.1:41731";
        private readonly TextBox _urlBox;
        private readonly Label _statusLabel;
        private Process _serverProcess;

        public LauncherForm()
        {
            Text = "Flexcil Local Viewer";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ClientSize = new Size(620, 240);
            BackColor = ColorTranslator.FromHtml("#0f172a");
            ForeColor = ColorTranslator.FromHtml("#e2e8f0");

            var card = new Panel
            {
                Left = 16,
                Top = 16,
                Width = 588,
                Height = 208,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = ColorTranslator.FromHtml("#111827"),
            };

            var title = new Label
            {
                Left = 16,
                Top = 14,
                Width = 540,
                Height = 28,
                Text = "Flexcil Local Viewer",
                Font = new Font("Segoe UI", 13F, FontStyle.Bold),
                ForeColor = ColorTranslator.FromHtml("#f8fafc"),
            };

            var message = new Label
            {
                Left = 16,
                Top = 48,
                Width = 550,
                Height = 36,
                Text = "Server läuft. Nutze die Adresse im Browser, falls der Button nicht geht:",
                Font = new Font("Segoe UI", 9.5F),
                ForeColor = ColorTranslator.FromHtml("#cbd5e1"),
            };

            _urlBox = new TextBox
            {
                Left = 16,
                Top = 88,
                Width = 552,
                Height = 28,
                ReadOnly = true,
                Text = Url,
                BackColor = ColorTranslator.FromHtml("#020617"),
                ForeColor = ColorTranslator.FromHtml("#93c5fd"),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 10F),
            };

            var openButton = CreateButton("Oberfläche öffnen", true);
            openButton.Left = 16;
            openButton.Top = 130;
            openButton.Width = 190;
            openButton.Click += delegate { OpenUrl(); };

            var copyButton = CreateButton("Adresse kopieren", false);
            copyButton.Left = 218;
            copyButton.Top = 130;
            copyButton.Width = 170;
            copyButton.Click += delegate { CopyUrl(); };

            var closeButton = CreateButton("Schließen", false);
            closeButton.Left = 400;
            closeButton.Top = 130;
            closeButton.Width = 168;
            closeButton.Click += delegate { Close(); };

            _statusLabel = new Label
            {
                Left = 16,
                Top = 172,
                Width = 552,
                Height = 20,
                Text = "Starte lokalen Server...",
                Font = new Font("Segoe UI", 9F),
                ForeColor = ColorTranslator.FromHtml("#94a3b8"),
            };

            card.Controls.Add(title);
            card.Controls.Add(message);
            card.Controls.Add(_urlBox);
            card.Controls.Add(openButton);
            card.Controls.Add(copyButton);
            card.Controls.Add(closeButton);
            card.Controls.Add(_statusLabel);
            Controls.Add(card);

            Load += delegate { StartServer(); };
            FormClosing += delegate { StopServer(); };
        }

        private static Button CreateButton(string text, bool primary)
        {
            var button = new Button
            {
                Text = text,
                Height = 36,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                Cursor = Cursors.Hand,
            };

            button.FlatAppearance.BorderColor = primary
                ? ColorTranslator.FromHtml("#2563eb")
                : ColorTranslator.FromHtml("#334155");
            button.FlatAppearance.BorderSize = 1;
            button.BackColor = primary
                ? ColorTranslator.FromHtml("#2563eb")
                : ColorTranslator.FromHtml("#1e293b");
            button.ForeColor = Color.White;
            return button;
        }

        private void StartServer()
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var serverExePath = Path.Combine(baseDir, "Flexcil-Local-Viewer-Server.exe");

            if (!File.Exists(serverExePath))
            {
                _statusLabel.Text = "Server-EXE nicht gefunden: Flexcil-Local-Viewer-Server.exe";
                _statusLabel.ForeColor = ColorTranslator.FromHtml("#fca5a5");
                return;
            }

            try
            {
                var processStartInfo = new ProcessStartInfo
                {
                    FileName = serverExePath,
                    Arguments = "--no-window",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = baseDir,
                };

                _serverProcess = Process.Start(processStartInfo);
                _statusLabel.Text = "Server läuft auf http://127.0.0.1:41731";
                _statusLabel.ForeColor = ColorTranslator.FromHtml("#86efac");
            }
            catch (Exception exception)
            {
                _statusLabel.Text = "Server konnte nicht gestartet werden: " + exception.Message;
                _statusLabel.ForeColor = ColorTranslator.FromHtml("#fca5a5");
            }
        }

        private void StopServer()
        {
            try
            {
                if (_serverProcess != null && !_serverProcess.HasExited)
                {
                    _serverProcess.Kill();
                    _serverProcess.WaitForExit(2000);
                }
            }
            catch
            {
            }
        }

        private static void OpenUrl()
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = Url,
                    UseShellExecute = true,
                });
            }
            catch (Exception exception)
            {
                MessageBox.Show(
                    "Konnte Browser nicht öffnen.\n\n" + exception.Message,
                    "Flexcil Local Viewer",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }

        private void CopyUrl()
        {
            try
            {
                Clipboard.SetText(Url);
                _statusLabel.Text = "Adresse in die Zwischenablage kopiert.";
                _statusLabel.ForeColor = ColorTranslator.FromHtml("#93c5fd");
            }
            catch (Exception exception)
            {
                MessageBox.Show(
                    "Kopieren fehlgeschlagen.\n\n" + exception.Message,
                    "Flexcil Local Viewer",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }
    }
}