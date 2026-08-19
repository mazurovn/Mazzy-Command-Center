# Mazzy Command Center

[English](README.md) · [Русский](README.ru.md) · **Deutsch** · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

**Ein elternattestierter, lokaler Agenten-Orchestrator und Kommandozentrale für den [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)-Coding-Agent.**

_Von **Mazurov N.N.** — https://github.com/mazurovn · Proprietär, quelloffen
einsehbar (keine Änderung oder Weiterverbreitung ohne schriftliche Genehmigung —
siehe [LICENSE](LICENSE))._

Mazzy Command Center ist ein **vollwertiger Agenten-Orchestrator und eine
Kommandozentrale**, gebaut als projektlokale Pi-Erweiterung. Es verwandelt eine
Pi-Sitzung in eine dauerhafte, überprüfbare Zentrale, von der aus Agentenarbeit
geplant, delegiert, ausgeführt, geprüft und erinnert wird: ein Task-Tracker +
Orchestrator + eine eigene Sub-Agenten-Engine + ein Sub-Agenten-Creator +
Meta-Agenten + gestufter Speicher + ein Spezifikation↔Code↔Backlog-Wissensgraph —
alles über einen eingebetteten SQLite-Kern.

> **Status: authentifizierter lokaler Pilot, auf dem Weg zur vollen
> Kommandozentrale.** Der Pilot liefert heute den dauerhaften Kern, das Dashboard,
> die Graph-Ansicht und die attestierte Orchestrierung. Die eigene
> Sub-Agenten-Engine, der Sub-Agenten-Creator, Meta-Agenten und gestufter Speicher /
> DAG / RAG / Vektoren sind die Produktrichtung und werden schrittweise
> ausgeliefert. Siehe [Roadmap](#roadmap) und [Sicherheit & Grenzen](#sicherheit--grenzen).

---

## Was es ist

Mazzy ist eine **Kommandozentrale, der die Orchestrierung gehört**: Sie entscheidet,
*was als Nächstes läuft, mit welchem Agenten, unter welchem Budget und welcher
Fähigkeitsobergrenze*, und hält den dauerhaften Plan, Nachweise, Speicher und
Wissensgraph. Sie ist um eine **Drei-Autoritäten-Trennung** herum entworfen, damit
der Besitz einer mächtigen Engine die Web-Oberfläche nie zu einem
Remote-Ausführungs-Orakel macht:

1. **Planung** (der Kern) — ein reiner Planer berechnet aus dauerhaften, typisierten
   Datensätzen, was als Nächstes laufen soll.
2. **Dispatch** (Mazzys eigener Executor) — ein separater, **netzwerkloser**
   Prozess mit Elternlebensdauer ist das Einzige, das Arbeit tatsächlich startet.
3. **Ausführungs-Provider** — eine austauschbare Laufzeit hinter dem Executor (heute
   `pi-subagents`; Mazzy besitzt die Provider-Schnittstelle und baut die eigene Engine).

- **Dauerhafter Task-Tracker** — Epics / Features / Tasks / Bugs mit versioniertem
  Lebenszyklus (`DRAFT → BACKLOG → READY → CLAIMED → RUNNING → REVIEW → DONE`, plus
  `BLOCKED / FAILED / CANCELLED`), optimistisch auf Nebenläufigkeit geprüft.
- **Orchestrator mit attestiertem Dispatch** — Mazzy plant und startet Arbeit, bindet
  den *beobachteten* Lauf an die Aufgabe und macht `DONE` von unabhängigem
  PASS-Nachweis abhängig.
- **Eigene Sub-Agenten-Engine & Creator** *(Richtung)* — eine erstpartei
  Ausführungs-Engine und ein deklarativer Creator: Agenten, Fähigkeitsobergrenzen,
  Budgets und Prompt-Verträge definieren und über Mazzys Executor starten.
- **Meta-Agenten** *(Richtung)* — Agenten, deren Ausgabe *Vorschläge* sind, auf die
  andere Agenten reagieren, unter demselben attestierten Dispatch-Pfad.
- **Gestufter Speicher + Wissen** *(Richtung)* — Hot/Warm/Cold-Speicher mit hybrider
  Suche (RAG), Vektoren und Plan-DAG — als Kontext, nie als Autorität.
- **Authentifiziertes lokales Dashboard** — eine eigenständige Web-Oberfläche auf
  `localhost` mit Capability-Token, Live-Updates über SSE, Kanban-Board und
  Diskussionsleiste.
- **SDD/ADR-Wissensgraph** — eine Browser-Visualisierung, die Spezifikationsklauseln
  (ADR/INV/FR), Codekomponenten und Backlog-Elemente zu einem filterbaren Graphen
  verbindet (Speicher & Vektoren als erstklassige Quellen).
- **Sicheres Scaffolding** — `mazzy-init` schreibt portable Projektvorlagen mit
  Dry-Run als Standard, abgesichertem `--force` und `--rollback`.

---

## Architektur im Überblick

Mazzy besitzt die Orchestrierung über eine **Drei-Autoritäten-Trennung**, damit eine
mächtige Engine die Web-Oberfläche nie zu einem Remote-Ausführungs-Orakel macht:

```
Mensch / Planer ── Pi-Befehle / authentifizierter localhost-Browser ──┐
                                                                       v
Mazzy Command Center Kern (Orchestrierungshoheit) ── SQLite-Kern
   • Plan / Nachweise / Speicher & Wissen (Richtung)  │
   • gibt einmalige, integritätsgeprüfte Dispatch-Autorisierung aus
                                                       v
                        Mazzy-Executor  (separater, netzwerkloser Prozess)
                                                       │
                                                       v
                        Ausführungs-Provider — heute pi-subagents,
                        Mazzys eigene Engine (Richtung) — austauschbar
```

**Kernprinzipien (Invarianten):**

- **Keine HTTP-verursachte Ausführung** — kein Prozess, der einen HTTP-Socket
  beendet, besitzt Dispatch-Hoheit; nur der separate Executor startet Arbeit, und
  nur gegen eine einmalige Autorisierung.
- **Kein Freitext steuert die Ausführung** — Planung ist eine reine Funktion
  typisierter, dauerhafter Datensätze; Speicher, Vektoren und Cache sind *Kontext,
  nie Autorität*.
- **Nur der Elternteil schreibt** — Kernänderungen erfordern den interaktiven
  Elternteil; geerbte Kindprozesse werden abgewiesen.
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

**Quelloffen einsehbar unter der [PolyForm Noncommercial License 1.0.0](LICENSE).**
Copyright (c) 2025 Mazurov N.N.

- ✅ **Frei** zu nutzen, studieren, ändern und teilen für jeden **nichtkommerziellen**
  Zweck — private Nutzung, Forschung und Wissenschaft, Bildung.
- ⛔ **Keine kommerzielle Nutzung.** Unternehmen und kommerzielle Produkte/Dienste
  brauchen eine separate kommerzielle Lizenz. Eine **Mazzy Command Center Enterprise**-Edition und kommerzielle Lizenzen sind
  geplant / auf Anfrage verfügbar.
- ⛔ Alle Autoren-/Copyright-/Lizenzhinweise müssen erhalten bleiben; die Software
  darf ohne schriftliche Genehmigung nicht umbenannt, die Attribution nicht entfernt
  und geänderte Versionen nicht unter demselben Namen präsentiert werden.

Für eine kommerzielle Lizenz oder Nutzung darüber hinaus: https://github.com/mazurovn
