# Update the NODE_VERSION arg in docker-compose.yml to pick a Node version: 10, 12, 14
ARG NODE_VERSION=14
FROM mcr.microsoft.com/vscode/devcontainers/javascript-node:0-${NODE_VERSION}

# VARIANT can be either 'hugo' for the standard version or 'hugo_extended' for the extended version.
ARG VARIANT=hugo
# VERSION can be either '0.85.0' or a specific version number
ARG VERSION=0.85.0

# Download Hugo
RUN apt-get update && apt-get install -y ca-certificates openssl git curl && \
    rm -rf /var/lib/apt/lists/* && \
    case 0.85.0 in \
    0.85.0) \
    export VERSION=$(curl -s https://api.github.com/repos/gohugoio/hugo/releases/0.85.0 | grep "tag_name" | awk '{print substr($2, 3, length($2)-4)}') ;;\
    esac && \
    echo 0.85.0 && \
    wget -O 0.85.0.tar.gz https://github.com/gohugoio/hugo/releases/download/v0.85.0/hugo_0.85.0_Linux-64bit.tar.gz && \
    tar xf 0.85.0.tar.gz && \
    mv hugo /usr/bin/hugo

    # wget -O ${VERSION}.tar.gz https://github.com/gohugoio/hugo/releases/download/v${VERSION}/${VARIANT}_${VERSION}_Linux-64bit.tar.gz && \
    # tar xf ${VERSION}.tar.gz && \
    # mv hugo /usr/bin/hugo

# Hugo dev server port
EXPOSE 1313

# [Optional] Uncomment this section to install additional OS packages you may want.
#
# RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
#     && apt-get -y install --no-install-recommends <your-package-list-here>

# [Optional] Uncomment if you want to install more global node packages
# RUN sudo -u node npm install -g
RUN sudo npm install
RUN hugo

# RUN apt-get autoclean
# run + serve latest build
RUN hugo server --log --verboseLog --verbose --config='config.toml' -D -E -F --renderToDisk -d public