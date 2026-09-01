# Adding and configuring a brand

Everything Canon writes belongs to a **brand**. This page covers creating one, what Canon sets up behind it, the four files that make it real, and what happens when you delete it.

## Organisations and brands

An **organisation** is the agency's client, the company you invoice. A **brand** is the thing Canon writes for: one website, one set of facts, one roadmap. See [Organisations and brands](../concepts/organisations-and-brands.md) for how the two levels fit together.

Most organisations run a single brand, and Canon treats that as the normal case. Where an organisation runs several, each brand keeps its own canonical facts, its own resources and its own roadmap, and shares none of them with its siblings. That separation is deliberate. Shared facts would let a writer cite one brand's verified figures inside another brand's article.

An organisation holds no facts and no roadmap. It is a grouping and nothing else. Blogs are only ever created inside a brand.

## Adding an organisation

Adding an organisation creates its first brand at the same time, because an organisation with no brands has nothing in it.

Three doors open the same form:

- The sidebar row **Add organisation**, under the **Organisations** heading, shown when you are not inside an organisation.
- **Add organisation** in the organisation switcher at the top of the sidebar.
- The **Add an organisation** page, which is where Canon sends you when the app is empty.

Fill in three things:

| Field | What to put in it |
| --- | --- |
| **Organisation name** | The agency's client. If it runs a single brand, that brand takes this name. |
| **This organisation has multiple brands** | Leave it off for the usual case. Tick it to reveal **First brand name** and name the brand separately from the organisation. |
| **Brand website** | The brand's live site, including `https://`. |

Press **Add organisation**. A toast confirms it. Canon then takes you to the new brand, after the client login dialog below when the organisation is new.

If you type a name that already exists, the line under the field says so and names how many brands that organisation holds. Tick **This organisation has multiple brands** to file your new brand under it. Left unticked, the brand would take the organisation's own name, and Canon refuses that as a duplicate rather than creating a near twin of a brand you already have.

!!! note "There is no industry or description to fill in"
    The form states this itself: "The description and the industry are detected automatically from the brand website once you add the organisation, so there is nothing to pick or write here." There is no field for either, and neither is edited later.

## What happens the moment the brand exists

Canon derives a **slug** from the name, lowercase with hyphens, for example `vacation-village`. The slug is permanent. It keys the brand's files, its output folder and every progress feed, so nothing renames it later, even when you rename the brand.

Canon then starts a short Claude session that reads the brand website and writes two things straight to the record: the brand **Description** and the **Industry**. You do not wait for it. When it lands you get a notification, "Description generated", and the brand's **Overview** and **Settings** pages show both.

The industry matters because it picks the writer's industry reference. A site that fits none of the known industries is recorded as `Others`, which is a real answer rather than a failure.

If Canon could not read the site, it saves nothing rather than guessing. The **Description** card stays empty and says so.

## The client login

When the organisation is new, Canon mints its client portal login in the same act and shows it to you once, in a dialog headed **Client login for *brand***. It carries **Email** and **Password**, each with a copy button beside it, and one way out: **I have saved it**.

The email is the organisation's slug at `portal.strategi.is`, for example `vacation-village@portal.strategi.is`. Send both to your client.

!!! danger "The password is shown once and cannot be read back"
    Copy it before you press **I have saved it**. The dialog has no dismiss and no outside click for exactly this reason. The only durable copy lives in a file called `.env.portal-credentials` on the machine running Canon, readable by that machine's account alone. If the password is lost, it has to be reset on that machine. Nothing in the dashboard can show it to you again.

A brand joining an organisation that already has a login gets no dialog and no second password. The one login already reaches every brand in that organisation.

## Adding another brand to an organisation

There are two doors, and which one you get depends on where you are standing.

=== "From inside the organisation"

    An organisation holding two or more brands has its own page, listing every brand as a card. **Add brand** sits at the top right.

    The dialog asks for **Name**, **Organisation** (already filled in and locked), **Domain** and **Market**. **Market** is prefilled with `India, English`.

=== "From the sidebar or the switcher"

    The organisation switcher carries a row reading **Add brand to *organisation***, and the sidebar shows **Add brand** while you are on an organisation's page.

    Both open a page headed **Add a brand to *organisation***, which asks for **Brand name** and **Brand website** only. The organisation is stated rather than asked, because it is already settled.

    This form does not ask for a market. The brand takes the house default, `India, English`, and you change it in [Settings](../guide/settings.md) if the brand sells somewhere else.

A single brand organisation has no page of its own: Canon sends you straight to the brand. The switcher row is how you give it a second brand.

## The four files behind a brand

Canon keeps a folder per brand on the machine running the engine, at `clients/<slug>/`. Four files in it decide what gets written. You do not have to open any of them, but knowing what they are makes the rest of Canon easier to read.

| File | In plain language | Who manages it |
| --- | --- | --- |
| `client.md` | The brand brief: name, website, market, and which industry reference the writer must read. | Canon writes it when the brand is created, and writes the **Market** from [Settings](../guide/settings.md) into it before every run. |
| `canonical-facts.md` | The binding fact base. Verified facts, verified URLs, and the do-not-claim list every article is scored against. | Canon builds it on the first blog run. The dashboard shows it and can delete it. Editing it is a job on the engine machine. |
| `gates.json` | The mechanical rules: the word band, the permitted entity names, the banned phrases. The gate script reads this and fails a draft that breaks them. | Canon writes it at creation and lays it down again from the record before every run. There is no screen for it. |
| `roadmap.csv` | The content plan: one row per topic, with what the piece covers and the prompts it must answer. | The [Content Roadmap](../guide/roadmap.md) tab. |

Canon writes two more small files beside them, `description.md` and `custom-instructions.md`, from the brand description and from **Custom blog instructions** in [Settings](../guide/settings.md).

## The fact base

`canonical-facts.md` is the most load bearing thing Canon holds for a brand. Every blog for that brand is written against it, every draft is scored against it, and no article may contradict it. It is one file, inherited by everything, which is why a thin one is not one thin blog but twenty.

### Canon will not write a blog without one

A brand with no fact base does not get refused. The first time you press **Generate**, the engine builds the fact base first and the run waits for it. Nothing is dispatched until it exists, because blogs written against nothing cite nothing.

If the build fails, the whole run fails and no blog is written. That is deliberate: the alternative is twenty articles quietly written against a fact base that was never there.

A fact base that a person has started and marked with the word `PLACEHOLDER` is a different case, and it does refuse. The brand's card and its **Overview** carry an amber note reading "canonical-facts.md still contains the token PLACEHOLDER and has not been reviewed", above the line "This client cannot generate real blogs until its canonical facts are reviewed". Finish the review on the engine machine and the note goes.

### Building it

There is no button that builds a fact base. A blog run builds it, which means there is exactly one way it can happen and no second way to disagree with the first. See [Runs, the queue, and stopping work](runs-and-queue.md) for what a run does around it.

The session reads, in this order: the files you uploaded to [Resources](../guide/resources.md), then the live site, then keyword data for the brand's market. It writes verified facts, verified URLs, known conflicts and their resolution, a do-not-claim list, and a section of claims it found but could not confirm, which blogs are forbidden to cite.

If the brand has no fact base **and** no resources, pressing **Generate** asks you first, in a dialog headed ***brand* has no fact base yet**. **Upload resources** takes you to the Resources tab with nothing submitted. **Proceed anyway** runs it on the live site alone.

!!! warning "Building the fact base spends quota before the first blog starts"
    It is a long step on its own. Upload the brand's brochures, spec sheets and price lists first, at the moment answering costs nothing. See [Resources](../guide/resources.md).

### Reading it and clearing it

On the brand's **Overview**, the **Canonical facts** card carries **View canonical facts**, which opens the file in a panel you can read and scroll. This is the answer to "where did that claim come from".

The card is read only, on purpose. Changing a file the whole pipeline treats as binding is a review, not a keystroke.

Beside it, **Delete** clears the fact base completely, after a confirm. The next blog run drafts a fresh one from the site and the resources. Blogs already written keep whatever they cited. Canon refuses the delete while a fact base build or a blog run is live for that brand, and says so.

## Deleting a brand

The control is at the bottom of the brand's **Settings** tab, under **Danger zone**, and it is called **Delete this brand**.

What is left behind depends on how the brand was filed. Where the organisation was named separately from its brands, by ticking **This organisation has multiple brands** when it was added or by naming one in the brand's **Settings**, deleting its last brand leaves the organisation behind, empty. That is not a leftover to ignore: the organisation still holds the client portal login, so it needs an answer either way. Its own page gives you both, and nothing else, because there is nothing else to do with it:

- **Add brand** puts a new brand under it, keeping the organisation and the login the client already has.
- **Delete organisation** removes it and revokes that login, so the password you sent the client stops working. One confirm, not two: an empty organisation holds no blogs, no roadmap and no resources, so the only thing being destroyed is the grouping and its login.

Where the brand is its own organisation, which is the usual case, there is nothing left to visit. Deleting the brand takes the organisation with it and revokes the client portal login in the same act, so no organisation page remains.

Canon refuses to delete an organisation that still has brands, and names them. Each brand goes through its own two-step delete first.

!!! danger "Deleting a brand destroys everything under it, with no undo"
    It removes the brand's record and every blog with its versions and comments, every channel post, the roadmap, all reports and analyses, the uploaded resources, and the brand's files on the machine running Canon. Nothing is archived and nothing is recoverable from the dashboard. Published articles already live on a client's website are not taken down, but Canon forgets them.

    Where the brand is its own organisation, which is what the usual single-brand add creates, deleting it also revokes that organisation's client portal login and deletes the account Canon minted for it, so the email and password you sent the client stop working. A brand that belongs to an organisation you named separately leaves that organisation and its login alone.

The full walkthrough of the two confirmation steps is on the [Settings](../guide/settings.md) page, beside the button itself.
