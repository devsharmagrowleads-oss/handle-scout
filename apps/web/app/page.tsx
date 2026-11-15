import { Scout } from '@/components/Scout';
import { ThemeToggle } from '@/components/ThemeToggle';

export default function Page() {
  return (
    <div className="page">
      <a className="skip-link" href="#search">
        Skip to search
      </a>

      <header className="masthead">
        <span className="wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          handle-scout
        </span>
        <ThemeToggle />
      </header>

      <main>
        <section className="intro">
          <h1>
            One name.
            <br />
            Every place it has to <em>work</em>.
          </h1>
          <p className="lede">
            Type a brand or your own name. You get the domains, the usernames, and alternatives ranked by how many
            places they are free. Where a site cannot be checked honestly, it says so and hands you the link.
          </p>
        </section>

        <Scout />
      </main>

      <footer className="colophon">
        <p>
          &ldquo;Available&rdquo; is a strong hint, not a guarantee: sites reserve names and block look-alikes without
          saying so. Register the ones that matter before you print anything.
        </p>
        <p>Open source, MIT licensed. No accounts, no tracking; names you check are not stored.</p>
      </footer>
    </div>
  );
}
