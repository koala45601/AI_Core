FROM searxng/searxng:latest

# Keep the source config outside the base image's declared /etc/searxng volume.
# The wrapper copies it into a tmpfs on every start, so Docker creates neither a
# host bind mount nor a persistent anonymous volume for Alpha.
COPY settings.yml /usr/local/share/alpha-searxng/settings.yml
COPY entrypoint.sh /usr/local/bin/alpha-searxng-entrypoint
RUN chmod 755 /usr/local/bin/alpha-searxng-entrypoint
ENTRYPOINT ["/usr/local/bin/alpha-searxng-entrypoint"]
