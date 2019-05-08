####
# Pull base image.
####
FROM ubuntu:18.04


####
# Install Node.js
####
RUN apt-get update
RUN apt-get install --yes wget
RUN wget -qO- https://deb.nodesource.com/setup_8.x | bash -
RUN apt-get install --yes nodejs


####
# Install build tools
####
RUN apt-get install --yes build-essential libpcap-dev zlib1g-dev libfuse-dev pkg-config fuse git


####
# Build MooseFS client from source
####
RUN git clone https://github.com/moosefs/moosefs.git /moosefs
WORKDIR /moosefs
RUN ./linux_build.sh
RUN make install


####
# Install Docker volume driver API server
####
# Create directories for mounts
RUN mkdir -p /mnt/moosefs
RUN mkdir -p /mnt/docker-volumes

# Copy in package.json
COPY package.json package-lock.json /project/

# Switch to the project directory
WORKDIR /project

# Install project dependencies
RUN npm install

# Set Configuration Defaults
ENV HOST=mfsmaster \
    PORT=9421 \
    ALIAS=moosefs \
    ROOT_VOLUME_NAME="" \
    MOUNT_OPTIONS="" \
    REMOTE_PATH=/docker/volumes \
    LOCAL_PATH="" \
    CONNECT_TIMEOUT=10000 \
    LOG_LEVEL=info

# Copy in source code
COPY index.js /project

# Set the Docker entrypoint
ENTRYPOINT ["node", "index.js"]
