FROM denoland/deno:latest

WORKDIR /app
USER deno

COPY *.ts .
RUN deno cache model.ts
RUN deno cache http_server.ts

CMD ["run", "-A", "http_server.ts"]
