# Chumz Phone — Agent Guide

This is the reference guide for using the Chumz Phone dashboard — the tool support agents and supervisors use to answer calls, work tickets, and (for supervisors) configure how the phone line behaves. If something here doesn't match what you see on screen, the app is the source of truth — flag the mismatch to whoever maintains it.

Most of this guide applies to every agent. Sections that are supervisor-only are marked as such, and the whole final section is a supervisor reference.

## Contents

1. [Getting set up](#1-getting-set-up)
2. [Finding your way around](#2-finding-your-way-around)
3. [Taking a call](#3-taking-a-call)
4. [The Live Queue](#4-the-live-queue)
5. [Making a call](#5-making-a-call)
6. [Contacts](#6-contacts)
7. [Wrap-up: turning a call into a ticket](#7-wrap-up-turning-a-call-into-a-ticket)
8. [Tags & Tickets](#8-tags--tickets)
9. [Calls history and callbacks](#9-calls-history-and-callbacks)
10. [Your stats and the Dashboard](#10-your-stats-and-the-dashboard)
11. [Keyboard shortcuts](#11-keyboard-shortcuts)
12. [Troubleshooting](#12-troubleshooting)
13. [Supervisor reference](#13-supervisor-reference)

---

## 1. Getting set up

### There's no separate phone

Chumz Phone doesn't use desk phones or a separate softphone app. Your **browser tab is your phone** — as long as it's open and you're signed in, calls can reach you through it. Close the tab, and you stop being reachable, the same as unplugging a desk phone.

### Signing in

Open the dashboard and sign in with your work Google account — there's no separate username or password to remember or reset. The first time you ever sign in, the system creates your agent record automatically. That record starts with no phone number and no softphone attached, which means you exist in the system but can't take calls yet — the next step covers why.

### Getting your softphone provisioned

Before you can go **Available**, a supervisor needs to set you up with a softphone from the **Agents** page (see [§13](#agents-roster--provisioning)). This is a one-click action on their end, but it has to happen before your status can be anything other than **Offline**. If you sign in and your status is stuck on Offline with no way to change it, this is almost always why — see [Troubleshooting](#12-troubleshooting).

Once it's done, nothing further is required on your side to "install" anything. The next time you load the dashboard, your browser registers your softphone in the background automatically.

### Microphone permission

The first time your softphone registers, your browser will prompt for microphone access. **Allow it** — this is what lets your browser carry call audio. If you accidentally dismiss or block this prompt, see [Troubleshooting](#12-troubleshooting) for how to fix it without needing IT.

### Going Available

Once you have a softphone and microphone access, switch your status to **Available**. That's the whole setup — see [§13](#agents-roster--provisioning) is only for supervisors adding *other* people; there's nothing else for you to configure. Keep your tab open, and calls will start reaching you.

---

## 2. Finding your way around

The sidebar is your main navigation. Every agent sees:

- **Dashboard** — your home page: today's numbers and your own performance.
- **Live Queue** — who's on hold right now, and for how long.
- **Calls** — Incoming, Outgoing, and Missed call history, with one-click callback.
- **Tags & Tickets** — every ticket ever logged, searchable and filterable.
- **Contacts** — your personal speed-dial list, plus a directory to call teammates directly.

Four more items — **Analytics**, **Agents**, **IVR Builder**, and **Settings** — only appear in the sidebar if you're a supervisor. They're not just hidden behind a "no permission" message if you're a regular agent: they don't render in your sidebar at all, and the pages themselves refuse to load their data for you even if you somehow navigate to the URL directly. If you believe you should have supervisor access and don't, ask an existing supervisor to change your role from the Agents page.

Everywhere in the app, a floating dialer and your status/presence control sit in a fixed position — you never need to visit a specific page just to make a call or change your status.

---

## 3. Taking a call

### How a call actually reaches you

When a caller is waiting, Chumz Phone doesn't pick one agent to ring — it **rings every currently-Available agent's browser at the same time**. Whoever answers first gets the call, and the ringing stops for everyone else automatically. This means:

- You don't need to race to be first — if you're mid-conversation with a teammate or briefly away, someone else will pick it up.
- If nobody is Available, the call sits in the queue (see [§4](#4-the-live-queue)) until someone is, or until it's abandoned or forwarded (supervisors: see [§13](#call-forwarding-rules)).

While you're being rung, your status automatically flips to **Ringing**, and once you answer, it flips to **On call** — both are automatic; you don't set them yourself (see the full list of statuses below).

### Your presence status

Your status pill tells the queue whether you can be rung. Three of the five possible states are automatic; you only ever set two of them yourself:

| Status | Set by | Meaning |
|---|---|---|
| **Available** | You | You'll be rung for the next waiting caller. |
| **On call** | System | You're on a live call. Nothing else can ring you until it ends. |
| **Ringing** | System | A caller is ringing your browser right now. |
| **Break** | You | You're stepping away for a few minutes. You won't be rung, but you're still signed in. |
| **Offline** | You (or automatic, before setup) | Signed out or done for the day. Also the state you're stuck in before a softphone is provisioned. |

### Answering

An incoming call shows a banner with the caller's number and an **Answer** button. You can also just press <kbd>A</kbd> anywhere on the page — it's a global shortcut that works as long as you're not currently typing into a text field, so you don't need to click into anything first.

### During the call

The active-call bar gives you:

- **Mute** — mutes your microphone; the caller can't hear you but you can still hear them.
- **Hold** — puts the caller on hold with hold music (see [§13](#hold-music) for how that music is chosen).
- **Speaker toggle** — switches audio output, if your browser supports choosing an output device. Not every browser does (Safari and Firefox notably don't expose this), so this control may not appear for you.

If a caller reports hearing their own voice echoed back, it's almost always because you're using your laptop's built-in speakers rather than a headset — the speaker output is being picked back up by the microphone. Switching to a headset resolves it immediately; there's no setting in the app that fixes this, since it's a physical acoustic issue, not a software one.

The call keeps working through minor hiccups on its own: if your wifi briefly drops or your network changes, the softphone tries to recover the connection for a few seconds before giving up. If the caller is still there when it reconnects, you'll notice nothing beyond a short gap. Only if it can't recover does the call actually end.

### Ending the call

Click **Hang up**. The [wrap-up prompt](#7-wrap-up-turning-a-call-into-a-ticket) opens automatically right after, every time — there's no way to skip it, by design, since it's how a call becomes a ticket someone else can act on later.

---

## 4. The Live Queue

The Live Queue page shows exactly who's on hold right now and how long they've been waiting — useful both for a supervisor watching overall load and for any agent deciding whether to jump in and help.

At the top, four stat tiles: **In Queue**, **Avg Wait**, **Longest Wait**, and **Agents Available** — a live read of current load at a glance.

Below that, a table of everyone currently waiting, each row showing the caller, their stage (**Waiting**, meaning they're already past the IVR menu and purely on hold, or **In menu**, meaning they're still pressing digits), and their wait time. Wait time is color-coded so a long wait is visible without reading the number:

- Under 60 seconds — normal.
- 60–89 seconds — amber.
- 90 seconds or more — red, and the row visibly pulses.

You don't have to wait for the ring-all to reach you. Any agent can click into a specific waiting caller's row to **claim** them directly instead — useful if you can see someone's been waiting unusually long and want to make sure they're picked up next. Claiming rings your softphone exactly the same way a normal ring-all call would; if someone else claims the same caller first, or the caller hangs up right as you claim them, you'll just see a normal "already gone" message rather than an error.

Supervisors additionally get the ability to force-end a row that looks stuck (see [§13](#agents-roster--provisioning)) — that's the one control on this page that isn't available to a regular agent.

---

## 5. Making a call

The floating dialer, available on every page, places both outbound and internal calls.

### Calling an outside number

Type a local number the normal way you'd say it out loud — e.g. `0712345678`. You don't need to add the country code yourself; the dialer reformats it automatically. Only Kenyan mobile numbers are supported today (numbers starting `07…` or `01…`); anything else will be rejected as invalid before it ever dials out.

### Calling a teammate

Rather than looking up a colleague's phone number, you can call them directly by name from the **Team** tab on the Contacts page (see below) — it rings their softphone the same way an external call would ring yours, with nothing going out over the phone line at all.

### One-click callback

From the Calls page's Missed tab, every row has a **Call back** button that redials that caller without you needing to copy their number anywhere — see [§9](#9-calls-history-and-callbacks).

---

## 6. Contacts

The Contacts page has two independent sections.

### My Contacts

Your own personal speed-dial list — nobody else sees these. Add a contact with just a name and phone number (same format rules as the dialer: `0712345678` or `+254712345678`, Kenyan numbers only). Each saved contact gets a **Call** button that dials them straight from the softphone, and a **Remove** button (with a confirmation, since removing one is permanent — there's no edit, only add and remove). This list is meant for numbers you call often enough that retyping them every time is wasted effort — a customer you're following up with over several days, for instance.

### Team

A live directory of every teammate, refreshing automatically every few seconds, showing each person's name and current presence status in plain language (Available, On a call, Ringing, On break, Offline). The **Call** button next to a teammate is only clickable when they're actually Available — if they're on a call, on break, or offline, the button is disabled with a tooltip explaining why, rather than letting you dial someone who can't answer.

---

## 7. Wrap-up: turning a call into a ticket

Every call you hang up opens a short wrap-up prompt automatically. This is the only way a call becomes a **ticket** that a supervisor (or you, later) can track, filter, and follow up on — a call that's answered but never wrapped up leaves no record beyond the raw call log.

### Disposition

Pick whichever of the four fits the call:

- **Resolved**
- **Escalated**
- **Follow-up needed**
- **No resolution**

Picking **Escalated** automatically bumps the suggested priority up to **High** — worth leaving as-is unless you have a specific reason to change it, since it's meant to make sure an escalated issue doesn't quietly sit at the same default priority as a routine resolved call.

### Priority and notes

Adjust the priority if the default doesn't fit, and add a short note — a line or two on what the caller actually needed is enough. Whoever picks up the resulting ticket later has only this note and the caller's number to go on, so specificity here saves them a callback just to ask "what was this about again?"

Click **Finish & log call** to create the ticket. You can also just click **Dismiss** if a call genuinely doesn't need a ticket (a wrong number, for instance) — nothing is created, but the prompt still appeared, since the app doesn't try to guess in advance which calls are ticket-worthy.

### Logging a ticket without waiting for hang-up

You don't have to wait until a call ends to create its ticket. Pressing <kbd>T</kbd> at any point during an active call opens a compact ticket drawer on the spot — useful for a long call where you want to jot something down partway through rather than trying to remember it at the end. This drawer also shows you any tickets *already* logged for the current call, specifically so you can see at a glance whether you (or someone before you, on a transferred call) already created one, rather than accidentally logging a duplicate.

Pressing <kbd>E</kbd> during an active call opens the full wrap-up prompt early, before you've even hung up, if you'd rather get it out of the way while the details are fresh.

---

## 8. Tags & Tickets

This page is the searchable home for every ticket ever created — not just your own calls.

### Ticket fields

A ticket carries: which call it came from, the caller's name and number, a **tag**, a **priority**, a **status**, an **assigned agent**, and free-text **notes**.

- **Statuses**: Open, Resolved, Escalated, Follow-up needed, No resolution.
- **Priorities**: Low, Medium, High, Urgent.

Note that a ticket's status vocabulary is deliberately different from a call's own status (which is things like "completed" or "failed") — a ticket's status describes the *outcome of the issue*, not what happened to the phone call itself, so don't expect the two to line up.

### Working the list

Every ticket appears in a paginated table with each of tag, priority, status, and assigned agent shown as an editable dropdown right in the row — so updating a ticket as it progresses (say, moving it from Open to Resolved once you've followed up) doesn't require opening anything separate. There's also a small notes editor available per row for updating the notes after the fact. Changes save immediately as you make them; you'll only see a toast notification if something fails to save, not on every successful edit, since a toast for every single dropdown change across a busy row of tickets would be more noise than help.

You can filter the whole list by:

- **Caller** — free-text search.
- **Status**
- **Tag**

A **Clear** button appears once any filter is active, to get back to the full list quickly.

Above the ticket table, a separate "Recent calls" list lets you jump straight to creating a ticket for a specific past call via a **+ Ticket** button, pre-filled with that caller's details — handy if you need to log something for a call you didn't wrap up at the time.

### Ticket tags (supervisor-only)

Supervisors get an additional panel here to manage the list of tags available across the whole team (adding new ones, or removing ones no longer needed). Removing a tag warns that agents will no longer be able to select it for *new* tickets — tickets already using it keep it.

---

## 9. Calls history and callbacks

The Calls page is the full history of every call, split into three tabs:

- **Incoming** — calls that reached an agent, showing duration and who took them.
- **Missed** — nobody picked up in time.
- **Outgoing** — calls placed from the dialer, including callbacks you've made.

Every tab can be filtered by date range and by caller number, and is paginated.

### Callbacks

Every row on the **Missed** tab has a **Call back** button. Click it once, and the app redials that caller through the dialer immediately — no need to find and copy their number. Once you've called back a given missed call, that button changes to a **✓ Called back** indicator (though it stays clickable, in case you need to call again) — this exists specifically so that if several agents are looking at the same missed-call list, nobody duplicates a callback that's already been made.

### Call details

Clicking into any row opens a detail view with:

- The call's **status**, the **agent** who handled it (if any), its **duration**, and — if the caller left one — a **star rating** from the post-call rating prompt (supervisors: see [§13](#call-rating)).
- Every **ticket** logged against this specific call, shown in full (status, priority, tag, notes, assignee).
- **History with this caller** — up to five other past calls from the same number, so you can see at a glance whether this is a repeat caller and what happened last time, without leaving the drawer to search for them separately.

This view is a read-only summary — it doesn't play back a recording or offer a way to create a new ticket directly from inside it; use the wrap-up flow or the Tags & Tickets page for that.

---

## 10. Your stats and the Dashboard

The Dashboard is what you land on when you open the app — a quick read of how the day is going.

- **Today's KPIs** — total calls handled, missed calls, and a breakdown by call type, so you can see at a glance what kind of issues are coming in.
- **Calls-by-hour chart** — when the day is actually busy, useful for knowing when to expect a rush.
- **A capped live-calls panel** — a glance at what's happening right now.
- **Your own performance**, called out separately from the team leaderboard — your calls answered today and your average handle time, so you don't have to scan a full team table just to find your own numbers.

The full team leaderboard and deeper historical breakdowns live on the **Analytics** page, which is supervisor-only — see [§13](#analytics-supervisor-only).

---

## 11. Keyboard shortcuts

All three shortcuts are automatically disabled while your cursor is in a text field, search box, or dropdown — so typing a caller's name or a ticket note will never accidentally trigger one.

| Key | Does what | When it works |
|---|---|---|
| <kbd>A</kbd> | Answer a ringing call | Any time a call is ringing you |
| <kbd>T</kbd> | Open the quick-ticket drawer | Only during an active call |
| <kbd>E</kbd> | Open the wrap-up prompt early | Only during an active call, before hang-up |

---

## 12. Troubleshooting

**My status is stuck on Offline and I can't change it.**
Your softphone hasn't been provisioned yet. This is a one-click step only a supervisor can do, from the Agents page (see [§13](#agents-roster--provisioning)). Ask them to add it, then reload the dashboard — you should be able to switch to Available right after.

**The browser is asking for microphone access.**
Allow it — this is what lets your browser act as your phone; without it, calls can reach you but you (and the caller) will hear nothing. If you already dismissed or blocked the prompt by mistake, click the padlock or site-info icon in your browser's address bar, find the microphone permission for this site, set it to Allow, and reload the page.

**The caller can hear themselves echo.**
Almost always your laptop's built-in speakers picking your voice back up through the microphone. Switch to a headset — it resolves the moment you do, since it's a physical audio path issue, not a setting inside the app.

**My call dropped after my wifi hiccuped.**
The softphone tries to recover the connection on its own for a few seconds before giving up. If the caller is still on the line when it reconnects, the call picks back up with no action needed from you. If it doesn't recover in time, the call ends and you'll need to call the customer back.

**I switched apps or locked my screen mid-call, and the caller stopped hearing me.**
Backgrounding your browser tab — switching to another app, locking your phone screen — can pause your microphone at the operating-system level; this is a deliberate battery/privacy behavior in the browser, not a bug in the app. Coming back to the tab fixes it automatically within a second or two. If it doesn't recover, hang up and call the customer back.

**I don't see a speaker/audio-output toggle during a call.**
Not every browser lets a page choose which audio output device to use — Safari and Firefox notably don't support this. If you're on one of those browsers, this control simply won't appear; it's not broken, that browser just doesn't expose the capability the app needs.

**I can't reach Analytics / Agents / IVR Builder / Settings.**
Those are supervisor-only, both in the sidebar and if you try the URL directly — nothing loads for a regular agent account. If you believe you should have supervisor access, ask an existing supervisor to update your role from the Agents page.

---

## 13. Supervisor reference

Everything above applies to supervisors too — this section covers what's *additionally* available to you.

### Agents (roster & provisioning)

The Agents page is the full roster: every agent's name, phone number, email, role (agent or supervisor), and current status. From here you can:

- **Add or edit** an agent's name, phone, email, and role.
- **Provision a softphone** — click **Add Softphone** next to anyone who doesn't have one yet. This generates their credentials and, when the sync to the phone system succeeds immediately, tells you so; if the live sync doesn't go through right away, you'll see a note that it's pending, with a **Sync** button to retry later without needing to re-provision from scratch.
- **Override a stuck status** — if someone's presence looks wrong (stuck on Ringing or On call when they're clearly not, for instance), you can change it directly here rather than waiting for it to self-correct.
- **Search** the roster by name or phone.

An agent with a softphone provisioned simply goes Available and gets rung in the browser like everyone else described above. An agent who hasn't been migrated to a softphone yet (legacy setups) instead gets rung on their actual phone number when marked Available — from an agent's own point of view this looks identical, but it's worth knowing when you're troubleshooting someone's setup.

### Analytics (supervisor-only)

A team-wide view, distinct from the personal numbers every agent sees on their own Dashboard:

- **Today's KPI cards** — total calls, incoming, outgoing, broken down further by issue type (login, deposit, agent request), and missed calls.
- One card — **team average handle time** — is deliberately **all-time**, not scoped to today, since a single day rarely has enough answered calls to be a meaningful average on its own.
- **Calls-by-hour chart** for the day.
- **Missed calls, by reason** — split into three causes: abandoned before an agent answered, forwarded because nobody was online, and outside business hours. This breakdown is today-only; the Calls page is where you'd look for missed-call history further back.
- **Team status right now** — a live count of how many agents are in each presence state.
- **Tickets** — an overall resolution rate, plus breakdowns of open tickets by tag and by priority.
- **Agent performance leaderboard** — unlike the KPI cards above it, this table is **all-time**, ranked by number of calls answered, showing total calls, answered, missed, and average handle time per agent.

### IVR Builder (supervisor-only)

Controls exactly what a caller hears before they reach an agent.

**Greeting** — the message played at the very start of every call, with a voice selector (Default, Lady, or Man) and a speaking-speed slider. The speed control changes cadence length, not raw playback speed — a slower setting sounds like someone speaking more slowly, not a sped-up recording. Changes only save when you click **Save**, and the button only becomes active once you've actually changed something.

**Menu enabled** toggle — this one applies the instant you click it, unlike the greeting above. Turning the menu **off** means callers hear only the greeting and go straight into the queue, entirely skipping the "press 1 for..." options; turning it back on restores the normal menu immediately for the next call.

**Menu options** — one row per digit a caller can press, each with a label ("Press 2 for…"), an action, and (depending on the action) a message:

- **Say a message** — plays a message, then continues (e.g., hangs up or moves on, depending on the message's own content).
- **Transfer to an available agent** — sends the caller into the same queue everyone else in this guide has been described going through.
- **Repeat this menu** — replays the whole greeting and menu from the start.

Each row saves independently, and a live **call flow preview** on the same page shows exactly what a caller would hear right now — the greeting text, followed by "Press N for [label]" for every configured option — so you can sanity-check a change before it goes live. Removing the *last* remaining option is called out specially: doing so is equivalent to turning the menu off entirely, since there'd be nothing left to press.

### Call Forwarding & Settings (supervisor-only)

Four panels live under Settings:

**Business Hours** — an on/off toggle, opening and closing time (East Africa Time), which days of the week are "open," and an after-hours message. Outside these hours, callers hear that message instead of the normal menu, and no agent needs to be online for this to work at all. Turning this **on** requires confirming the change, since it immediately affects what the very next caller outside those hours will hear; turning it off doesn't ask for confirmation, since disabling something is treated as the safe direction.

**Call forwarding rules** — you can define a destination (an agent, a queue name, or a number) for each of four conditions: **No answer**, **Line busy**, **Always**, and **After hours**. It's worth knowing exactly what's real here today: **only "No answer" is actually wired into live routing**, and only in the specific case where *zero* agents with a softphone are Available at all — one or two agents being busy still queues normally rather than forwarding. "Line busy" and "Always" rules can be saved, but nothing in the live system currently acts on them. "After hours" is superseded entirely by the dedicated Business Hours panel above, which has its own message and its own logic — a rule set here for that condition has no additional effect.

**Call rating** — a single toggle that, when on, plays a 1–5 rating prompt to the caller right after the agent hangs up, before the line disconnects. Off by default, since it changes what every caller experiences on every call; turning it on asks for confirmation for the same reason the Business Hours toggle does. The resulting rating shows up as a star rating on that call's detail view (see [§9](#9-calls-history-and-callbacks)).

**Hold Music** — upload a custom MP3 (up to 8MB) to replace the default music callers hear while on hold in the queue, or reset back to the default. This takes effect immediately, including for anyone already on hold at the moment you change it — nobody needs to redial to hear the new track.

**A general rule across all four of these panels**: turning something **on** that changes what a live caller experiences always asks you to confirm first; turning it **off** never does, since disabling something is the reversible, lower-risk direction.

---

*This guide describes the dashboard as it behaves today. If you find something here that no longer matches reality, say so — this file is meant to be corrected, not treated as fixed documentation.*
