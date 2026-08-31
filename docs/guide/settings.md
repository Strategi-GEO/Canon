# Settings

There are two Settings in Canon, and they are about different things.

- **The brand's Settings tab**, the last row of the brand sidebar. What the engine knows about one brand.
- **The app's Settings**, pinned at the bottom of the sidebar behind a gear icon. The version of Canon on this computer, and software updates.

This page covers both, brand first.

## The brand Settings tab

Open a brand and press **Settings**. The heading reads "What the engine knows about *brand*", and five cards sit under it.

### Description

Read only, and read only everywhere. Canon generates the brand description from the brand website when the brand is added, and no screen offers a way to change it. Every writing run reads it as context.

An empty card means Canon could not read the site when the brand was created. It saves nothing rather than inventing a summary.

### Identity

The card opens by naming the brand's slug and stating that it is permanent. The engine stores this brand's facts and output under that slug, so renaming the brand never moves it.

| Field | What it does |
| --- | --- |
| **Organisation** | Which organisation this brand sits under. Type to filter the ones that exist, or type a new name to create one. The line under the box tells you which of the two is about to happen before you save. |
| **Domain** | The brand's live site. It wins over internal documents on any conflict, so it is what the researcher fetches first. |
| **Market** | Where this brand sells and in what language, for example `India, English`. |
| Industry | Read only. Detected from the brand website when the brand was added. It picks the industry reference the writer loads. |

**Save changes** stays disabled until you actually change something, and Canon sends only the fields you touched, so a save in one browser tab cannot overwrite a change made in another.

!!! warning "Leave the market set"
    Keyword volumes are validated against the market, and the researcher prefers sources local to it. A brand with an empty market has keyword validation skipped on every blog. Change it only when the brand genuinely sells somewhere else.

Moving a brand to a different organisation rewrites one field and renames nothing. The brand keeps its slug, its facts, its resources and its roadmap, and its client portal login follows it, so nobody is locked out.

### Blog destination

Where this brand's finished blogs are published. Until one is set, the **Post** control on every blog for the brand stays disabled, because there is nowhere for an article to go.

The card holds the whole connection flow: **Their blog page** with a **Detect** button, a **Platform** dropdown, whatever credentials the chosen platform needs, and **Connect**. Once connected it shows a green chip naming the destination, with **Change** and **Disconnect** beside it.

Nothing is stored until the engine has proved the credential against the site, so there is no separate Save. A saved but unverified credential would put a live **Publish** button in front of you that fails on a real article, on a client's real website.

The two destinations are not the same act, and one of them publishes live. Read [Publishing](publishing.md) before you connect anything.

### Custom blog instructions

Standing instructions every blog for this brand must follow, in your own words. A text box, a **Save changes** button, and nothing else.

The engine obeys them as a major priority, above its house style and above the roadmap guidance. They never outrank the brand's canonical facts, and no instruction here licenses inventing a source or a statistic.

Good instructions are the ones that would otherwise be a note in someone's head:

- "Always cite an India specific source for market data."
- "Address the reader as you."
- "Never open with a rhetorical question."

They apply to every blog written from now on. Existing drafts are not rewritten. To shape one run only, use the instructions box that appears when you press **Generate**.

An empty box is a real setting: saving it blank clears the instructions.

### Danger zone

One button, **Delete this brand**, and two locks in front of it.

1. **Consent.** The dialog names the brand and everything it is about to remove. Tick "I understand this permanently deletes *brand* and everything in it, with no undo" to enable **Continue**.
2. **Confirm.** Type the brand's slug exactly to enable **Delete *brand* forever**. **Back** returns you to the first step, and closing the dialog resets both.

!!! danger "This cannot be undone"
    It permanently deletes the brand's record and every blog with its versions and comments, every channel post, the roadmap, all reports and analyses, the uploaded resources, and the brand's files on the machine running Canon. Nothing is archived, and the dashboard cannot recover any of it. Articles already published to a client's website stay up, but Canon forgets that they exist.

Canon refuses the delete while a run is live for that brand, and answers "a run is live for ...; stop it before deleting the brand". Stop the run first.

There is no separate delete for an organisation. An organisation exists only as long as it has brands, so deleting the last brand in one takes the organisation off the list with it.

## The app Settings

The gear at the very bottom of the sidebar opens a dialog headed **Settings**, described as "The version of Strategi Canon running on this machine, and software updates". It appears on the app installed on your computer, and it is about the app itself rather than about any brand.

**Strategi Canon** at the top shows the version on this computer, for example `v0.2.33`.

Under **Software update**, one of four things is on screen:

- **Checking for updates...** while it looks. It re-checks every time you open the dialog.
- "You are on the latest version", with **Check again** beside it.
- **Update available: v...**, with an **Update now** button.
- A confirmation that the update is downloaded and Canon is restarting.

**Update now** downloads the new version and stages it. Canon restarts itself to apply it, so the dashboard disconnects and reconnects a few seconds later. Your keys and your work are kept, and there is nothing to re-enter.

!!! note "An update waits for a running blog"
    Updating restarts the app, which would kill a live run. When a blog is generating, the button is disabled and the dialog reads "A blog is generating. You can update once it finishes."
