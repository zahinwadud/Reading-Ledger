# Reading Ledger

A free personal book-tracking website with a private dashboard.

- **Public site** (`index.html`): anyone can browse your shelves, search, and open a page for each book.
- **Dashboard** (`admin.html`): only you can log in to add, edit and delete books, upload covers and import lists.
- **Cost: nothing.** The pages are hosted free on **GitHub Pages**. The data, login and cover images live on the free **Supabase** plan.

There is nothing to install and no build step. You copy files and paste a few values.

---

## Setup (about 30 minutes)

You will do three things: **(A)** set up Supabase, **(B)** put your two Supabase values into the files, **(C)** publish on GitHub.

### A. Supabase (database, login, cover storage)

**1. Create a project**
1. Go to <https://supabase.com> and sign up (free).
2. Click **New project**. Give it a name, choose a database password (save it somewhere), pick the region closest to you, and click **Create new project**.
3. Wait a minute or two until it is ready.

**2. Create your owner account**
1. In the left menu open **Authentication → Users**.
2. Click **Add user → Create new user**. Enter your email and a strong password, tick **Auto Confirm User**, and create it.
3. Click the new user and **copy the "User UID"** (a long code like `3f2a9c1e-...`). You need it in the next step.

**3. Create the database tables**
1. On your computer, open `supabase/schema.sql` in a text editor (Notepad is fine).
2. Find `REPLACE_WITH_MY_USER_UUID` (it appears **once**) and replace it with the User UID you copied. Keep the quote marks around it. Save the file.
3. In Supabase open **SQL Editor → New query**, paste the whole file, and click **Run**. You should see "Success".

This creates the `books` table and a public `covers` storage bucket. Everyone can *read*; only your account can *write*.

**4. Turn off public sign-ups**
1. Open **Authentication → Sign In / Providers** (older projects: **Authentication → Settings**).
2. Turn **off** "Allow new users to sign up" and save. (Nobody else can change your data anyway, but this keeps strangers from creating accounts.)

**5. Find your two Supabase values**
1. Open **Project Settings → API Keys** (or click the **Connect** button at the top of the page).
2. Copy the **Project URL**, like `https://abcdxyz.supabase.co`.
3. Copy the **Publishable key** (starts with `sb_publishable_`). If you don't see a publishable key but see *Create new API keys*, click it. If your project only has legacy keys, copy the **anon** key instead.

> Never use the **secret** key (`sb_secret_...`) or the **service_role** key anywhere on this site.
> The URL and publishable key are safe to publish. Row-level security in the database is what protects your data: visitors can only read, and only your account can add, change or delete.

### B. Put your values into the files

Open `js/config.js` in a text editor and paste your two values between the quote marks:

```js
export const SUPABASE_URL = 'https://abcdxyz.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_...';
```

(The variable is still called `SUPABASE_ANON_KEY`; it simply holds your publishable key.) Leave `YOUTUBE_API_KEY` as it is for now. Save the file.

### C. Publish on GitHub

**6. Create the repository**
1. Sign up at <https://github.com> (free) and click **+ → New repository**.
2. Name it, for example, `reading-ledger`. The name becomes part of your website address.
3. Choose **Public** (free GitHub Pages needs a public repository), then **Create repository**.

**7. Upload the files**
1. On the new repository page click **uploading an existing file** (or **Add file → Upload files**).
2. Open the unzipped folder on your computer, select **everything inside it** (`index.html`, `admin.html`, the `css`, `js`, `icons` and `supabase` folders, `sw.js`, `manifest.webmanifest`, `README.md`) and drag it into the browser window. Upload the *contents*, not the zip itself.
3. Wait for the upload to finish, then click **Commit changes**.
4. Check that `index.html` and the `js` folder appear in the file list. (If `.nojekyll` didn't upload because it is hidden on your computer, that's fine.)

**8. Turn on GitHub Pages**
1. In the repository open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**. Choose branch **main** and folder **/ (root)**, then **Save**.
3. Wait one or two minutes and refresh. The page shows your address:
   `https://YOUR-NAME.github.io/reading-ledger/`

**9. Add your first book**
1. Open `https://YOUR-NAME.github.io/reading-ledger/admin.html` and sign in with the email and password from step 2. **Bookmark this page**: there is no login link on the public site, except the small person icon in the top bar.
2. Click **+ Add book** (on a phone, the round **+** button), upload a cover, fill in the details and click **Save book**.
   - **Audiobooks:** choose Format = Audiobook and paste the YouTube link. The video's thumbnail appears and is used as the cover automatically.
3. Open the main address to see the book on your shelf.

That's it. Your site is live.

---

## Install it as an app (optional)

The site can be installed on a phone or computer like an app. It gets its own icon, opens full-screen, and the shelf still opens with no connection (it shows the copy saved on your last visit).

- **Android (Chrome):** open the site, tap the **⋮** menu, then **Add to Home screen → Install**.
- **iPhone (Safari):** tap **Share → Add to Home Screen**.
- **Computer (Chrome or Edge):** click the install icon at the right end of the address bar.

The installed app is the same site and the same database, so anything you add in the dashboard shows up in it. It updates by itself when you publish a change. The files behind this are `manifest.webmanifest` (name, colours, icons), `sw.js` (the offline copy) and the `icons` folder; upload them with the rest.

## The four sections

- **Home** and **Books** are the shelves. On a phone, the filters sit behind one **Filters** button.
- **Comics** shows every title with the genre *Comics*, *Manga* or *Graphic novels*, grouped by series, with how far you are through each one. Comics still count in the shelves and totals; this is only another way to look at them.
- **Stats** shows what was finished each year and month, the split between books, comics and audiobooks, and a yearly goal. Set the goal in the dashboard under **Tools → Reading goal**; it then shows on every device. (That tool shows a one-time database step the first time.)
- **Open the app on this page** (at the bottom of the Hardcopy, Ebook and Want to Buy pages) makes that page the opening screen on that one device.

## Working in the dashboard

- **Edit from the site:** while you are signed in, every book page on the public site shows an **Edit** button that opens that book's form. Saving or closing takes you back to the book.
- **Open a book** by clicking its row (on a phone, tap it). The tick box and the status menu in a row work on their own.
- **Needs attention** counters under the count cards show how many books lack a cover, a genre or a finish date; click one to see just those.
- **Count cards** at the top filter the list when clicked. Under the search box there are more filters (type, language, what is missing) and the sort order; on a wide screen the Title and Author headings sort the list too.
- **Reading status** can be changed right in the list. Choosing *Read* fills in today as the finish date if the book has none.
- **Change many books at once:** tick books (or tick the box in the table heading for all of them), then use the bar at the bottom to add or remove a genre, or set status, ownership, language, copies or series.
- **Delete** is inside the book's form, at the bottom left.
- **Several authors:** write them in the Author box separated by commas (`Brian Michael Bendis, Jeph Loeb`). Each author gets their own page, and the book appears on all of them.

### Tools

The **Tools** button holds five helpers. Each one shows what it found and changes nothing until you press its button.

- **Download a backup:** saves every book to a file. Do this before big changes.
- **Find duplicates:** lists titles that appear more than once; you choose the copy to keep.
- **Tidy author names:** suggests authors written in more than one way (for example in Bengali and in English letters) and lets you pick one spelling.
- **Series:** lifts series names out of titles such as "ছায়াশ্বাপদ (তিন গোয়েন্দা, #৪)". It needs a one-time database step, shown below.
- **Find covers:** looks books up on Open Library by title and author and shows covers to choose from.

### Turning on series (one time)

In Supabase open **SQL Editor → New query**, paste these two lines and click **Run**:

```sql
alter table public.books add column if not exists series text;
alter table public.books add column if not exists series_no numeric;
```

Reload the dashboard. The book form now has a Series field, and the public site shows a page for each series.

## Importing your Goodreads list (optional)

1. On a computer, open Goodreads, go to **My Books**, choose **Import and export** under *Tools*, and click **Export Library**. Download the CSV file. (The Goodreads phone app cannot export.)
2. In your dashboard click **Import → Goodreads**, choose that file, and look through the list. Untick books you don't want, and tap **Bengali** on the ones that are Bengali (Goodreads doesn't record language).
3. Press **Import**. Nothing is saved before this step, and the file never leaves your device.

Good to know:
- **Covers:** Goodreads does not put covers in the export, and it has no public API any more. The import can look covers up by ISBN on [Open Library](https://openlibrary.org) and saves a *link* to each one, so it uses none of your free storage. Many books (especially Bengali ones) won't be found. Choose **No cover** in the dashboard filter to find them and upload your own; an uploaded cover always replaces the link.
- **Already have the books?** Titles that match one already in your shelf are unticked automatically.

## Importing comics from Comic Vine (optional)

Your dashboard can bring in comic issues with their covers, writers and summaries from [Comic Vine](https://comicvine.gamespot.com), a large comics database.

1. Sign in at comicvine.gamespot.com (free), open <https://comicvine.gamespot.com/api> and copy your API key.
2. In the dashboard click **Import → Comics** and paste the key. It is kept in that browser only. **Do not put it in `js/config.js`**: that file is public on GitHub.
3. Search for a series (*Batman*) or a story arc (*Batman: Hush*). For a long series, give the issue numbers you want (for example 608 to 619).
4. Check the list: set the series name, tick the issues, and use **I have read up to** to mark the ones you have finished. Then press **Import**.

Comics have three levels, and the import keeps them apart:

- the **series** an issue was published in (*Batman*) and its **number** there (#608);
- the **story arc** it belongs to, if any (*Hush*). An arc can run through more than one series.

Pick a story arc and each issue keeps its own series, with the arc filled in. Pick a series and the import can read each issue's arc from Comic Vine. On the site, a series page groups its issues by arc, and each arc has its own page with a progress bar.

Story arcs need two more columns, a one-time step. In Supabase open **SQL Editor → New query**, run these lines, then reload the dashboard (Tools → Series shows them with a copy button):

```sql
alter table public.books add column if not exists arc text;
alter table public.books add column if not exists arc_no numeric;
```

Good to know:
- Issues you already have are not added twice. The import only fills in what they lack (cover, story arc) and changes nothing else.
- New issues get the genre *Comics*, so they appear in the Comics section, and they count in the shelves and totals like any other title.
- Covers are saved as links to Comic Vine's pictures, so they use none of your storage.
- Comic Vine asks for about one request a second, so looking up the writers takes about a second per issue.

## Adding a short series by hand

For a series no database has, **Import → A series by hand** creates all its issues in one go.

1. Enter the series name, the writer, the year and how many issues there are.
2. Add the covers. **Add covers from files** takes all the pictures at once and gives each to the issue whose number is in its file name (`1.jpg`, `vanya-02.png`). You can also click one cover box, drop a picture on a row, or paste the address of a cover image. Issue title, year and page count are optional; an issue with no year of its own uses the series year.
3. Use **I have read up to**, then press **Add**.

Issues that are already on your shelf (same series, same number) are skipped. A picture you choose is shrunk and saved in your own storage; a pasted address is saved as a link and only works while that site keeps the picture there.

**Load from file** fills the form from a small JSON file instead of typing. One series looks like this (a file may also hold a list of them):

```json
{
  "series": "XenoGeist",
  "author": "Writer Name",
  "year": 2024,
  "language": "English",
  "comics": true,
  "issues": [
    { "number": 1, "title": "Issue title", "date": "2024-03", "pages": 24, "cover": "https://example.com/cover1.jpg" },
    { "number": 2, "title": "Issue title", "date": "2024-04", "pages": 24 }
  ]
}
```

Only `series` and `issues` are required. An issue can carry its own `author` when it differs from the series.

## Importing a YouTube playlist of audiobooks (optional)

Your dashboard can read a YouTube playlist and add each video as an audiobook (title, length and link; the cover is the video's own thumbnail). This needs a **free** YouTube API key, set up once:

1. Go to <https://console.cloud.google.com> and sign in with a Google account. Create a new project (any name).
2. Open **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → API key**.
4. Click the new key and **restrict it**: under *Application restrictions* choose *Websites* and add your site address (for example `https://YOUR-NAME.github.io/*`); under *API restrictions* choose *YouTube Data API v3*. A restricted key is safe to publish.
5. On GitHub, open `js/config.js`, click the pencil icon, paste the key in place of `PASTE_YOUR_YOUTUBE_API_KEY_HERE`, and **Commit changes**. Reload your dashboard after a minute.

Then click **Import → YouTube playlist** and paste the playlist link.

- The playlist must be **Public** or **Unlisted**. Private playlists and Watch Later cannot be read.
- It is free: reading a playlist costs about 1 unit per 50 videos (plus 1 per 50 for the details) out of a free allowance of 10,000 units a day.
- YouTube does not know a book's author. The import **guesses** the author and a clean title from the video title, and you check or fix each one before saving. Any left blank are saved as "Unknown"; search for *Unknown* in the dashboard to find them.
- If one audiobook is split into several videos, choose **One audiobook, in parts**. The lengths are added up and the link opens the first part inside the playlist, so the next parts play on.

---

## Good to know

- **Free Supabase projects pause after about 7 days of no activity.** If the site shows "The shelf is out of reach", open your project at supabase.com and click **Restore / Resume project**. Your data is kept. Visiting the site regularly keeps it awake.
- **Editing later:** to change a file on GitHub, open it, click the pencil icon, edit, and **Commit changes**. The site updates in a minute or two.
- **Updating the database file:** if you ever get a newer `schema.sql`, run it again in the SQL Editor (after putting your User UID back in). It is safe to repeat.
- **Site name:** it appears in `index.html` and `admin.html` (the `<title>` line) and in `js/public.js` (search for "Reading Ledger").
- **Covers** are shrunk to at most 600 px wide and compressed in your browser before upload, so they load fast and stay well inside the free storage limit.
- **Audiobook thumbnails** load straight from YouTube, so they cost no storage. If a video is later deleted, the card shows "No thumbnail" (you can upload an image for it).
- **Testing on your computer:** double-clicking `index.html` will not work, because browsers block modules from local files. Test on GitHub Pages, or run `python3 -m http.server` in the folder and open <http://localhost:8000>.

## Troubleshooting

| What you see | What to do |
|---|---|
| Page says "Almost there" or the dashboard says to add your Supabase URL and key | `js/config.js` still has the `PASTE_YOUR...` text. Paste your values, commit, wait a minute. |
| "The shelf is out of reach" | The project may be paused (see above), or the URL/key in `config.js` is wrong or has a stray space. |
| Wrong email or password | Use the account from step 2. Check the password, or reset it under Authentication → Users. |
| "This account is not allowed to change books" | The User UID in `schema.sql` doesn't match the account you log in with. In the SQL Editor run `create or replace function public.is_owner() returns boolean language sql stable as $$ select auth.uid()::text = 'YOUR-UID' $$;` with the right UID. |
| Cover upload fails | Make sure step 3 ran without errors (it creates the `covers` bucket). |
| Site shows old content after an edit | Wait a minute and hard-refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac). |
| Installed app shows old content | Open it while online and pull down to refresh (or close and reopen it). If you edited `sw.js`, raise its `VERSION` number. |
| Playlist import says to add a key | Follow the YouTube steps above, and make sure the key is restricted to your site address. |
| Playlist import says the key is restricted to other websites | In the Google console, add your exact site address (`https://YOUR-NAME.github.io/*`) to the key's allowed websites. |
