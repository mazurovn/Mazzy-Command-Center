# Mazzy Command Center

[English](README.md) · [Русский](README.ru.md) · **Deutsch** · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

**Eine elternattestierte, lokale Task-Kommandozentrale für den [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)-Coding-Agent.**

_Von **Mazurov N.N.** — https://github.com/mazurovn · Proprietär, quelloffen
einsehbar (keine Änderung oder Weiterverbreitung ohne schriftliche Genehmigung —
siehe [LICENSE](LICENSE))._

Mazzy Command Center ist eine projektlokale Pi-Erweiterung, die eine Pi-Sitzung in
eine dauerhafte, überprüfbare Kommandozentrale für agentengesteuerte Arbeit
verwandelt: ein Task-Tracker, eine Entscheidungsoberfläche für Orchestrierung, ein
Review-/Nachweis-Ledger und ein authentifiziertes lokales Web-Dashboard — alles
über eine einzige eingebettete SQLite-Steuerungsebene.

> **Status: authentifizierter lokaler Pilot.** Eine Maschine, ein vertrauter
> Nutzer, projektlokale Persistenz und Prozessgrenzen zwischen Eltern und Kind. Es
> ist **noch kein** Mehrbenutzer-, Mehrmandanten- oder Remote-Produkt. Siehe
> [Sicherheit & Grenzen](#sicherheit--grenzen).

---

## Was es tut

Mazzy ist eine **Steuerungsebene**, keine zweite Ausführungsumgebung. Es
protokolliert und steuert Arbeit; die eigentliche Ausführung wird an `pi-subagents`
delegiert. Die übergeordnete Pi-Sitzung ist der einzige Schreiber der
Steuerungsebene; Kind-Agenten verändern den Zustand nie direkt — der Elternteil
attestiert beobachtete Ergebnisse.

- **Dauerhafter Task-Tracker** — Epics / Features / Tasks / Bugs mit einem
  versionierten Lebenszyklus (`DRAFT → BACKLOG → READY → CLAIMED → RUNNING → REVIEW
  → DONE`, plus `BLOCKED / FAILED / CANCELLED`). Jede Aktualisierung wird
  optimistisch auf Nebenläufigkeit geprüft.
- **Elternattestierte Orchestrierung** — der Elternteil bindet einen *beobachteten*
  Kindlauf an eine Aufgabe, bevor er sie als laufend deklariert; `DONE` erfordert
  einen unabhängigen PASS-Nachweis, keinen Kommentar.
- **Authentifiziertes lokales Dashboard** — eine eigenständige Web-Oberfläche auf
  `localhost` mit Capability-Token, Live-Updates über SSE, einem Kanban-Board und
  einer Task-Diskussionsleiste.
- **SDD/ADR-Graph** — eine Browser-Visualisierung, die Spezifikationsklauseln
  (ADR/INV/FR), Codekomponenten und Backlog-Elemente zu einem filterbaren Graphen
  verbindet.
- **Sicheres Scaffolding** — `mazzy-init` schreibt portable Projektvorlagen mit
  Dry-Run als Standard, abgesichertem `--force` und `--rollback`.

---

## Architektur im Überblick

```
Mensch ── Pi-Befehle / authentifizierter localhost-Browser ──┐
                                                              v
Pi-Elternteil + Erweiterungs-APIs ── Mazzy Command Center ── SQLite-Steuerungsebene
                                    │       │        │
                                    │       ├─ Diskussion / Nachweise / Berichte
                                    │       └─ attestierte Steuerungsbrücke
                                    v
                          pi-subagents (einzige Kind-Laufzeitumgebung)
```

**Kernprinzipien (Invarianten):**

- **Einzige Ausführungsumgebung** — `pi-subagents` führt Kinder aus; Mazzy erzeugt,
  plant, wiederholt oder beendet niemals Kindarbeit. Ihm gehört die
  *Entscheidungs*hoheit, nicht die *Ausführungs*hoheit.
- **Nur der Elternteil schreibt** — Änderungen an der Steuerungsebene erfordern den
  interaktiven Elternteil; geerbte Kindprozesse werden abgewiesen.
- **Kein Host-Pfad überquert die API** — nur opake IDs, Enums und relative
  Referenzen verlassen localhost.
- **Kommentare sind niemals Nachweise** — der maßgebliche PASS/FAIL-Kanal sind
  Reviewer-/Verifier-Nachweise.
- **Alle `git`-Aufrufe sind gehärtet** — Repository-Konfiguration/Hooks und
  geerbte Umgebung können die Ausführung nicht beeinflussen.

---

## Werkzeuge und Befehle

**Nur-Eltern-Werkzeuge** (die für das LLM sichtbare Oberfläche):

| Werkzeug | Zweck |
|---|---|
| `mazzy_task` | Aufgaben erstellen / auflisten / abrufen / aktualisieren (versioniert; `DONE` braucht PASS-Nachweis). |
| `mazzy_route` | Schreibgeschützte Richtlinienprüfung für Delegation (erzeugt nie). |
| `mazzy_assignment` | Elternattestierte Laufbindung, Abschlussimport und Reviewer-Nachweis. |
| `mazzy_discussion` | Dauerhafte Task-Diskussion lesen/beantworten. |
| `mazzy_control` | Claim/complete/fail für GO / PAUSE / STOP-Anfragen des Dashboards. |

**Slash-Befehle:** `/mazzy` (Status + Dashboard-URL), `/mazzy-url` (Zugriffs-URL mit
Token), `/mazzy-server` (start/stop/status), `/mazzy-menu` (`Ctrl+Alt+M`),
`/mazzy-init`, `/mazzy-doctor`, `/mazzy-registry`, `/mazzy-clean`.

---

## Installation

**Anforderungen**

| Komponente | Version |
|---|---|
| Node.js | `>= 22.19.0` |
| `@earendil-works/pi-coding-agent` | `0.84.2` |
| `@earendil-works/pi-ai` | `0.84.2` |
| `@earendil-works/pi-tui` | `0.84.2` |

**Aus npm installieren:**

```bash
pi install npm:@mazurovn/mazzy-command-center
# danach Pi neu starten, damit die Erweiterung erkannt wird.
```

**Aus GitHub installieren:**

```bash
pi install git:github.com/mazurovn/Mazzy-Command-Center
```

**Überprüfen:**

```bash
npm run typecheck
npm test
```

Führe in einer Pi-Sitzung `/mazzy` für Status und Dashboard-URL aus oder
`/mazzy-url`, um die authentifizierte Zugriffs-URL anzuzeigen (das Token wird nie
protokolliert).

---

## Sicherheit & Grenzen

Dies ist ein **authentifizierter lokaler Pilot** und sollte nicht als
Produktionssicherheitsversprechen gelesen werden.

- Eine Maschine, ein vertrauter Nutzer; Prozessgrenzen zwischen Eltern und Kind.
- **Keine** Mehrbenutzer-Autorisierung, **keine** Mandantentrennung, **keine**
  Remote-Identität, **keine** verteilte Schreibsperre.
- Eine Dashboard-Aktion, eine gesendete Steuerungsanfrage oder eine
  Elternbestätigung ist **kein** Nachweis für Ausführung oder Verifizierung.

Bitte melde Sicherheitsbedenken über einen privaten Kanal, nicht über ein
öffentliches Issue.

---

## Lizenz

**Proprietär, quelloffen einsehbar.** Copyright © 2026 Mazurov N.N. Alle Rechte
vorbehalten. Du darfst die Software ansehen, ausführen und evaluieren, aber du
darfst sie **nicht** ohne vorherige schriftliche Genehmigung des Autors ändern,
weiterverbreiten oder abgeleitete Werke erstellen, und jede erlaubte Kopie muss die
Autorennennung beibehalten. Vollständige Bedingungen in der Datei [LICENSE](LICENSE).
