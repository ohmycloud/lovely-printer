use clap::{Parser, Subcommand};
use lovely_printer::{PrintRequest, Printer, api};
use std::{
    io::{self, Read},
    net::SocketAddr,
};

#[derive(Parser)]
#[command(version, about = "MotoPager · A little love, on paper")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    /// Start the web printer (also the default command).
    Serve {
        #[arg(long, env = "PRINTER_BIND", default_value = "127.0.0.1:3000")]
        bind: SocketAddr,
        #[arg(long, env = "DATABASE_URL", default_value = "sqlite://printer.db")]
        database: String,
    },
    /// Send text to the running printer. Use '-' to read stdin.
    Print {
        text: String,
        #[arg(long, env = "PRINTER_URL", default_value = "http://127.0.0.1:3000")]
        server: String,
    },
    /// List print history as JSON.
    History {
        #[arg(long, env = "PRINTER_URL", default_value = "http://127.0.0.1:3000")]
        server: String,
        #[arg(long, default_value = "20")]
        limit: u32,
        #[arg(long, default_value = "0")]
        offset: u32,
    },
    /// Generate a note; optionally send it straight to the printer.
    Inspire {
        #[arg(long, default_value = "love", value_parser = ["love", "poetry", "lyrics"])]
        kind: String,
        /// Lyrics search term (default: 海阔天空).
        #[arg(long, default_value = "海阔天空")]
        query: String,
        #[arg(long)]
        print: bool,
        #[arg(long, env = "PRINTER_URL", default_value = "http://127.0.0.1:3000")]
        server: String,
    },
}
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lovely_printer=info,tower_http=info".into()),
        )
        .with_writer(io::stderr)
        .init();
    let command = Cli::parse().command.unwrap_or(Command::Serve {
        bind: std::env::var("PRINTER_BIND")
            .unwrap_or_else(|_| "127.0.0.1:3000".into())
            .parse()?,
        database: std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://printer.db".into()),
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    match command {
        Command::Serve { bind, database } => {
            let printer = Printer::open(&database).await?;
            let listener = tokio::net::TcpListener::bind(bind).await?;
            tracing::info!("MotoPager ready → http://{}", listener.local_addr()?);
            axum::serve(listener, api::router(printer))
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
        Command::Print { mut text, server } => {
            if text == "-" {
                text.clear();
                io::stdin().read_to_string(&mut text)?;
            }
            output(
                client
                    .post(format!("{}/api/print", server.trim_end_matches('/')))
                    .json(&PrintRequest {
                        text,
                        source: "cli".into(),
                    })
                    .send()
                    .await?,
            )
            .await?;
        }
        Command::History {
            server,
            limit,
            offset,
        } => {
            output(
                client
                    .get(format!(
                        "{}/api/notes?limit={limit}&offset={offset}",
                        server.trim_end_matches('/')
                    ))
                    .send()
                    .await?,
            )
            .await?;
        }
        Command::Inspire {
            kind,
            query,
            print,
            server,
        } => {
            let server = server.trim_end_matches('/');
            let response = client
                .get(format!("{server}/api/print/random"))
                .query(&[("type", &kind), ("q", &query)])
                .send()
                .await?;
            let status = response.status();
            let message: serde_json::Value = response.json().await?;
            if !status.is_success() {
                return Err(format!("{status}: {message}").into());
            }
            let item: lovely_printer::random_content::RandomContent =
                serde_json::from_value(message)?;
            if print {
                let text = item.print_text();
                output(
                    client
                        .post(format!("{server}/api/print"))
                        .json(&PrintRequest {
                            text,
                            source: format!("cli:{}", item.source),
                        })
                        .send()
                        .await?,
                )
                .await?;
            } else {
                println!("{}", item.print_text());
            }
        }
    }
    Ok(())
}
async fn output(response: reqwest::Response) -> Result<()> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(format!("{status}: {body}").into());
    }
    let value: serde_json::Value = serde_json::from_str(&body)?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
