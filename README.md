# ⚒️ BootForge

> **Build. Boot. Break. Fix.**

BootForge is a lightweight desktop sandbox for experimenting with **bootable systems, disk images, virtual machines, and low-level development** without having to manage a complicated VM workflow manually.

Built with **Electron** and powered by **QEMU**, BootForge brings the pieces together into one simple environment.

---

## 🚀 What is BootForge?

Working with bootable images and low-level software can quickly become annoying:

- Configure QEMU
- Find the right executable
- Set up the disk image
- Pass the correct boot arguments
- Start the VM
- Read the output
- Stop it
- Change something
- Do it all again

BootForge is built to make that workflow easier.

Instead of constantly working with long commands and manual configuration, BootForge aims to give you a **simple desktop interface for creating, launching, and experimenting with virtual systems**.

---

## ✨ Features

- 🖥️ **Desktop Interface** — A clean Electron-based interface for managing your sandbox.
- ⚙️ **QEMU Integration** — Launch and control virtual machines through QEMU.
- 💾 **Disk Image Support** — Work with bootable disk images and virtual drives.
- 🥾 **Boot Experiments** — Test bootable systems and low-level projects.
- 🐛 **Debug-Friendly** — Easily inspect what happens when your virtual system starts.
- ⚡ **Fast Iteration** — Make changes, rebuild, and boot again quickly.
- 🔒 **Sandboxed Environment** — Experiment inside a virtual machine instead of directly on your physical system.

---

## 🧠 Why BootForge?

BootForge is made for people who enjoy understanding **what happens underneath the operating system**.

Whether you're learning about boot processes or building something completely experimental, the goal is to remove unnecessary friction from the process.

### The idea is simple:

```text
        Build
          ↓
        Boot
          ↓
         Test
          ↓
        Debug
          ↓
        Improve
          ↓
        Repeat
```

Spend less time fighting configuration.

Spend more time **building**.

---

## 🛠️ Built With

| Technology | Role |
|---|---|
| ⚡ Electron | Desktop application |
| 🖥️ QEMU | Virtual machine & hardware emulation |
| 🟨 JavaScript | Application logic |
| 🌐 HTML | Interface |
| 🎨 CSS | UI styling |
| 📦 Node.js | Runtime & tooling |

---

## 📂 Project Structure

```text
Bootforge/
├── agent/             # Agent / development components
├── dist/              # Build output
├── electron/          # Electron-related files
├── node_modules/      # Dependencies
├── renderer/          # Renderer / UI code
├── app.js             # Application entry point
├── index.html         # Main interface
├── package.json       # Project configuration
├── package-lock.json  # Dependency lockfile
├── styles.css         # Application styling
├── vm-manager.js      # Virtual machine management
└── README.md          # Documentation
```

> The structure may change as BootForge develops.

---

## 💻 Requirements

Before running BootForge, make sure you have:

- **Node.js**
- **npm**
- **QEMU**
- **Git** (recommended)

Check Node.js:

```bash
node --version
```

Check npm:

```bash
npm --version
```

Check QEMU:

```bash
qemu-system-x86_64 --version
```

---

## 🚀 Running BootForge

Clone the repository:

```bash
git clone https://github.com/Rishanredddy23/Bootforge.git
cd Bootforge
```

Install dependencies:

```bash
npm install
```

Start the development version:

```bash
npm run dev
```

The application should start as an Electron desktop window.

---

## 🧪 Development

BootForge is currently an evolving project.

The development workflow is intentionally simple:

```text
Edit → Run → Test → Fix → Repeat
```

If you are experimenting with QEMU or bootable images, keep your test environments isolated and avoid using real system disks for experiments.

---

## 🗺️ Roadmap

BootForge is still being built, and there is plenty more to come.

- [x] Electron desktop application
- [x] QEMU detection
- [x] Virtual machine management
- [x] Development environment
- [ ] Improved VM controls
- [ ] Better boot configuration
- [ ] Disk image management
- [ ] More detailed QEMU output
- [ ] Improved error handling
- [ ] VM profiles
- [ ] Snapshots
- [ ] More debugging tools
- [ ] Cross-platform improvements

---

## 🤝 Contributing

BootForge is an experimental project, and ideas are welcome.

If you find a bug, have an improvement, or want to contribute:

1. Fork the repository
2. Create a branch
3. Make your changes
4. Test them
5. Open a Pull Request

For bugs and feature ideas, feel free to open an Issue.

---

## ⚠️ Safety

BootForge is intended for **development, experimentation, and learning**.

QEMU provides virtualization, but you should still be careful when working with:

- Disk images
- Bootloaders
- Kernel code
- System-level scripts
- Administrator/root privileges

**Never point experimental tools at a real system disk unless you know exactly what the operation will do.**

Back up anything important before experimenting.

---

## 👨‍💻 Creator

**Rishan Reddy**

🌐 Portfolio: **rishanreddy23.in**

🐙 GitHub: **@Rishanreddy23**

BootForge is built as an ongoing project to make low-level experimentation more accessible and enjoyable.

---

## ⭐ Support

If you like BootForge or find it useful, consider giving the repository a **⭐ Star**.

It helps the project get discovered and supports future development.

If you build something interesting with BootForge, feel free to share it!

---

<div align="center">

## ⚒️ BootForge

**Build. Boot. Break. Fix.**

*Experiment beyond the operating system.*

⭐ **Star the repository if you like it.**

</div>
