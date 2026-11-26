FROM --platform=linux/amd64 python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/source

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fuse libfuse2 tar unzip util-linux \
    && rm -rf /var/lib/apt/lists/*

ARG TIGRISFS_VERSION=1.2.4
RUN ARCH=amd64 \
    && curl -fL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz \
    && tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ \
    && rm /tmp/tigrisfs.tar.gz \
    && chmod +x /usr/local/bin/tigrisfs

WORKDIR /app
COPY python/archive-parts/ /tmp/archive-parts/
RUN cat /tmp/archive-parts/scraper-image-only.zip.b64.* | base64 -d > /tmp/python.zip \
    && mkdir -p /app/source \
    && unzip -q /tmp/python.zip -d /app/source \
    && rm -rf /tmp/archive-parts /tmp/python.zip
COPY container/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY container/server.py /app/server.py
COPY container/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080
CMD ["/app/start.sh"]
