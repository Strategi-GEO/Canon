# Organisations and brands

Canon has two levels: an **organisation** and a **brand**. The organisation is the agency's client. The brand is the thing you actually write for, and it is where all the work lives.

Every blog, roadmap, resource and setting belongs to a brand. An organisation holds no articles of its own.

## The difference in one line

**An organisation is a grouping. A brand is a place work happens.**

Most clients are one brand, so their organisation and their brand are the same thing and you will barely notice the distinction. It matters when one client runs several brands: Acme Group with `acme-north` and `acme-south`, say, or a resort company with one property per location. Each brand then has its own facts, its own roadmap and its own blogs, and the organisation is what says they belong to the same client.

## What each level owns

| Level | Owns |
| --- | --- |
| **Organisation** | The name of the client, and the client's portal login, which is one login for the whole organisation. Nothing else. |
| **Brand** | The website, the market, the industry, the description, the canonical facts, the resources, the content roadmap, every blog and social post, and every setting including where blogs publish. |

That split has one practical consequence worth remembering: a client with three brands gets **one portal login**, and signing in with it shows them all three brands' articles.

## Getting around

The left sidebar is the whole navigation, and it changes depending on where you are.

When you are not inside a brand, it lists your **Organisations**. Click one and it lists that organisation's **Brands**. Click a brand and the sidebar becomes that brand's own menu:

**Overview**, **Content Roadmap**, **Blogs**, **LinkedIn**, **Medium**, **Bluesky**, **X**, **Repurpose**, **Reports**, **Analysis**, **Resources**, **Settings**.

If the organisation holds more than one brand, a brand switcher appears above that menu. With one brand there is no switcher, because it would have nothing to switch to.

!!! info "A single brand organisation has no page of its own"
    Opening an organisation that holds exactly one brand takes you straight to that brand. There is nothing an organisation page could show you there that the brand page does not, so Canon does not show you an empty floor.

    An organisation holding two or more brands does get its own page: a portfolio of brand cards, plus **Add brand**.

## Adding one

Two buttons, and which you want depends on whether the client already exists in Canon.

=== "A new client"

    Press **Add organisation**. It asks for:

    - **Organisation name**: the agency's client. If they run a single brand, that brand takes this name.
    - **This organisation has multiple brands**: a checkbox, off by default. Turn it on and a **First brand name** field appears, so the brand can be named separately from the organisation.
    - **Brand website**: the live site of the first brand.

    Adding an organisation creates its first brand at the same time. There is no such thing as an empty organisation.

=== "Another brand for a client you already have"

    Press **Add brand**, from the organisation's page, from the sidebar, or from the organisation switcher, where it reads **Add brand to *organisation***. It asks for the **Name**, the **Organisation**, the **Domain** and the **Market**.

    Typing the name of an organisation that already exists files the brand under it rather than creating a near duplicate.

!!! note "The description and the industry are detected, not typed"
    The moment a brand exists, Canon reads its website and writes both the description and the industry onto the record. Neither is a field you fill in, and the description is read only everywhere in the app: it is generated, and every writer run reads it.

    The **Market** is the one field only a person can supply, because the engine is forbidden from guessing it from a domain. It is prefilled with the house default, "India, English".

!!! warning "The brand's slug is permanent"
    The slug is derived from the brand's name when the brand is created, and it never changes afterwards. Everything on disk and in the ledger is keyed by it. Get the name right the first time.

## What a brand needs before it can write anything

Three things, and the first blog run will not go far without them.

**Canonical facts.** This is the binding fact base for the brand: what is true about it, which URLs are verified, and what must never be claimed. Every blog is written against it and no draft may contradict it. You will find it on the brand's **Overview**, on the **Canonical facts** card, with a **View canonical facts** button. It is read only in the app on purpose: changing a file the whole pipeline treats as binding is a review, not a keystroke.

If a brand has no fact base yet, the card says so, and the first blog run drafts one from the site and the resources before it writes anything.

**Resources.** The brochures, spec sheets and price lists that say what the brand says about itself. The researcher reads these before searching anything external. The **Resources** card on the Overview counts them and links to the full page.

**A content roadmap.** The list of topics, one row per planned blog. Nothing can be generated until a sheet exists. See [The Content Roadmap](../guide/roadmap.md).

!!! tip "Upload resources before the first run, not after"
    A thin fact base is not one thin blog. Every blog this brand ever gets inherits it. Uploading files now costs nothing, and fixing twenty blogs later costs a great deal.

## Where a brand's blogs publish

Each brand publishes to its own website, connected on **Settings** under **Blog destination**. WordPress is the one platform with a driver today.

Pressing **Publish** puts the article live on the client's domain, so it is the final release, and the only thing that authorises it is the client's own approval. The control does not appear before that.

A brand with no website connected has the Publish control disabled, with the reason on hover: connect the client's website first. There is no fallback destination and nothing publishes anywhere by default. That is the state every brand starts in.

## Brand settings

**Settings** in the brand's sidebar holds:

- **Description**: read only, generated from the website.
- **Identity**: the **Organisation**, **Domain** and **Market**. Moving a brand between organisations happens here.
- **Blog destination**: covered above.
- **Custom blog instructions**: extra standing guidance for this brand's runs.
- A **Danger zone**, for deleting.

!!! warning "Moving a brand to a different organisation changes who can see it"
    The client portal login belongs to the organisation, not to the brand. Move a brand and its articles appear under the new organisation's login and disappear from the old one's, from the moment the move is saved.

## The client's login

When a brand is created that forms a new organisation, Canon mints a portal login for that organisation and shows it once, in a dialog you cannot dismiss by clicking away. Copy it then and send it to the client.

The password cannot be read back from the app. The engine keeps a copy in a local credentials file on the machine that runs it, so an admin can recover or reset it there. A brand added to an organisation that already has a login does not mint a second one, because the login belongs to the organisation.
