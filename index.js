//
// Imports
//
const fs = require('fs-extra');
const ls = require('ls');
const path = require('path');
const childProcess = require('child_process');

const http = require('http');
const terminus = require('@godaddy/terminus');
const express = require('express');

//
// Globals
//

// Path on remote MooseFS filesystem that will be used for volume storage
const remotePath = process.env['REMOTE_PATH'];
// Used when not running as a Docker plugin to set the driver alias
let pluginAlias = process.env['ALIAS'];
if (pluginAlias === undefined || pluginAlias === '') {
  pluginAlias = 'moosefs'
}
// The name of the "root" volume ( if specified )
const rootVolumeName = process.env['ROOT_VOLUME_NAME'];
// MountPoint for remote MooseFS filesystem
const volumeRoot = '/mnt/moosefs';
// Directory to mount volumes to inside the container
const containerVolumePath = '/mnt/docker-volumes';
// Address that the webserver will listen on
const bindAddress = `/run/docker/plugins/${pluginAlias}.sock`;

// The directory that volumes are mounted to on the host system
let hostVolumePath = process.env['LOCAL_PATH'];

// If the `host_volume_basedir` is not set by the user, assume that API server
// running as a Docker plugin and that the host volume path is handled by Docker
// under the propagated mount: /mnt/docker-volumes.
if (hostVolumePath === undefined || hostVolumePath === '') {
  hostVolumePath = containerVolumePath
}

// Options to the `mfsmount` command
let mountOptions = [];
if (process.env['MOUNT_OPTIONS'].length !== 0) {
  mountOptions = process.env['MOUNT_OPTIONS'].split(' ')
}

/*
* Used to keep track of which volumes are in use by containers. For example:
* {
*   "volume_name": [
*     "mount_id1",
*     "mount_id2"
*   ]
* }
*/
let mountedVolumes = {};

// Records whether or not we have mounted the MooseFS volume root
let hasMountedVolumeRoot = false;

//
// Logging
//

const log = require('loglevel-message-prefix')(require('loglevel'), {
  prefixes: ['level'],
});

// Log level set by plugin config
log.setLevel(process.env['LOG_LEVEL']);

log.info('Starting up MooseFS volume plugin');

//
// Express webserver and middleware
//

let app = express();
// JSON body parser
app.use(express.json({type: () => true}));

// Plugin activation
app.use(function (req, res, next) {
  log.debug(containerVolumePath);
  log.debug(hostVolumePath);
  // If this is an activation request
  if (req.method === 'POST' && req.path === '/Plugin.Activate') {
    log.debug('/Plugin.Activate');
    res.json({
      Implements: ['VolumeDriver']
    })
  } else {
    next()
  }
});

/*
 * Custom middleware that makes sure the MooseFS remote filesystem is mounted
 * before any other plugin functions are executed.
 */
app.use(function (req, res, next) {
  // If we haven't mounted the MooseFS remote
  if (hasMountedVolumeRoot === false) {
    log.info('Mounting MooseFS remote path');

    try {
      // Mount MooseFS remote path
      childProcess.execFileSync(
        'mfsmount',
        [
          volumeRoot,
          '-H', process.env['HOST'],
          '-P', process.env['PORT'],
          '-S', remotePath,
          ...mountOptions
        ],
        {
          // We only wait 3 seconds for the master to connect.
          // This prevents the plugin from stalling Docker operations if the
          // MooseFS master is unresponsive.
          timeout: parseInt(process.env['CONNECT_TIMEOUT'])
        }
      );

      // Success
      hasMountedVolumeRoot = true;

      // Pass traffic on to the next handler
      next()

    } catch (err) {
      // Failure
      res.json({
        Err: err.toString()
      })
    }

  // If we have already mounted MooseFS remote
  } else {
    // Nothing to do, pass traffic to the next handler
    next()
  }
});

//
// Helper Functions
//

/*
 * Determine whether or not a volume is mounted by a container based on our
 * `mountedVolumes` object.
 */
function volumeIsMounted(volumeName) {
  return mountedVolumes[volumeName] !== undefined &&
      mountedVolumes[volumeName].length !== 0;
}

//
// Implement the Docker volume plugin API
//

app.post('/VolumeDriver.Create', function (req, res) {
  const volumeName = req.body.Name;
  const storageClass = req.body.Opts.StorageClass;
  const volumePath = path.join(volumeRoot, volumeName);

  log.info(`/VolumeDriver.Create: ${volumeName}`);

  if (volumeName === rootVolumeName) {
    // You cannot create a volume with the same name as the root volume.
    log.warn("Tried to create a volume with same name as root volume. Ignoring request.");

    // Return without doing anything.
    res.json({})
  }

  try {
    // Create volume on MooseFS filesystem
    fs.ensureDirSync(volumePath);

    // If the user specified a replication goal for the volume
    if (storageClass !== undefined) {
      // Set the replication goal
      execFileSync(
        'mfssetsclass',
        [storageClass, volumePath],
        {
          timeout: parseInt(process.env['CONNECT_TIMEOUT'])
        }
      )
    }

    // Success
    res.json({})

  } catch (err) {
    // Failure
    res.json({
      Err: err.toString()
    })
  }
});

app.post('/VolumeDriver.Remove', function (req, res) {
  const volumeName = req.body.Name;
  const volumePath = path.join(volumeRoot, volumeName);

  log.info(`/VolumeDriver.Remove: ${volumeName}`);

  if (volumeName === rootVolumeName) {
    // You cannot delete the root volume.
    // Return an error.
    res.json({
      Err: 'You cannot delete the MooseFS root volume.'
    })
  }

  try{
    // Remove volume on MooseFS filesystem
    fs.removeSync(volumePath);

    // Success
    res.json({})

  } catch (err) {
    // Failure
    res.json({
      Err: err.toString()
    })
  }

});

app.post('/VolumeDriver.Mount', function (req, res) {
  const volumeName = req.body.Name;
  const mountId = req.body.ID;
  const containerMountPoint = path.join(containerVolumePath, volumeName);
  const hostMountPoint = path.join(hostVolumePath, volumeName);

  log.debug(`/VolumeDriver.Mount: ${volumeName}`);
  log.debug(`           Mount ID: ${mountId}`);

  // If the volume is already mounted
  if (volumeIsMounted(volumeName)) {
    // Add the container to the list of containers that have mounted this volume
    mountedVolumes[volumeName].push(mountId);

    // Return the mount point
    res.json({
      Mountpoint: hostMountPoint
    })

  // If the volume has not been mounted yet
  } else {
    try {
      // Create volume mount point
      fs.ensureDirSync(containerMountPoint);

      let mount_remote_path = "";
      // If we are mounting the root volume
      if (volumeName === rootVolumeName) {
        // We mount the directory containing *all* of the volumes
        mount_remote_path = remotePath
      } else {
        // We mount the specified volume
        mount_remote_path = path.join(remotePath, volumeName)
      }

      // Mount volume
      execFileSync(
        'mfsmount',
        [
          containerMountPoint,
          '-H', process.env['HOST'],
          '-P', process.env['PORT'],
          '-S', mount_remote_path,
          ...mountOptions
        ],
        {
          // We only wait 3 seconds for the master to connect.
          // This prevents the plugin from stalling Docker operations if the
          // MooseFS master is unresponsive.
          timeout: parseInt(process.env['CONNECT_TIMEOUT'])
        }
      );

      // Start a list of containers that have mounted this volume
      mountedVolumes[volumeName] = [mountId];

      // Success: Return the mountpoint
      res.json({
        Mountpoint: hostMountPoint
      })

    } catch (err) {
      // Failure
      res.json({
        Err: err.toString()
      })
    }
  }
});

app.post('/VolumeDriver.Path', function (req, res) {
  const volumeName = req.body.Name;
  const hostMountPoint = path.join(hostVolumePath, volumeName);

  log.debug(`/VolumeDriver.Path: ${volumeName}`);

  // If the volume is mounted
  if (volumeIsMounted(volumeName)) {
    // Return the MountPoint
    res.json({
      Mountpoint: hostMountPoint
    });

  } else {
    // Nothing to return
    res.json({});
  }
});

app.post('/VolumeDriver.Unmount', function (req, res) {
  const volumeName = req.body.Name;
  const mountId = req.body.ID;
  const containerMountPoint = path.join(containerVolumePath, volumeName);

  log.debug(`/VolumeDriver.Unmount: ${volumeName}`);

  // Remove this from the list of mounted volumes
  mountedVolumes[volumeName].pop(mountId);

  // If there are no longer any containers that are mounting this volume
  if (mountedVolumes[volumeName].length === 0) {
    try {
      // Unmount the volume
      execFileSync('umount', [containerMountPoint]);

      // Success
      res.json({})

    } catch (err) {
      // Failure
      res.json({
        Err: err.toString()
      })
    }

  } else {
    // Success
    res.json({})
  }
});

app.post('/VolumeDriver.Get', function (req, res) {
  const volumeName = req.body.Name;
  const hostMountPoint = path.join(hostVolumePath, volumeName);

  log.debug(`/VolumeDriver.Get: ${volumeName}`);

  // If the volume is the root volume
  if (volumeName === rootVolumeName) {
    // If the root volume is mounted
    if (volumeIsMounted(rootVolumeName)) {
      // Return the volume name and the MountPoint
      res.json({
        Volume: {
          Name: rootVolumeName,
          Mountpoint: hostMountPoint
        }
      })

    // If the root volume is not mounted
    } else {
      // Return the volume name
      res.json({
        Volume: {
          Name: rootVolumeName
        }
      })
    }
  }

  try {
    // Check directory access on MooseFS directory
    fs.accessSync(path.join(volumeRoot, req.body.Name),
      fs.constants.R_OK | fs.constants.W_OK);

    log.debug(`Found Volume: ${volumeName}`);

    // If the volume is mounted
    if (volumeIsMounted(volumeName)) {
      // Return volume name and MountPoint
      res.json({
        Volume: {
          Name: volumeName,
          Mountpoint: hostMountPoint
        }
      })

    // If volume is not mounted
    } else {
      // Return volume name
      res.json({
        Volume: {
          Name: volumeName
        }
      })
    }

  } catch (err) {
    // Failure
    log.warn(`Cannot Access Volume: ${volumeName}`);

    res.json({
      Err: err.toString()
    })
  }
});

app.post('/VolumeDriver.List', function (req, res) {
  const volumes = [];

  log.debug('/VolumeDriver.List');

  // If the root volume name has been specified
  if (rootVolumeName !== "") {
    // If the root volume has been mounted
    if (volumeIsMounted(rootVolumeName)) {
      // Add the volume name and MountPoint
      volumes.push({
        Name: rootVolumeName,
        Mountpoint: path.join(hostVolumePath, rootVolumeName)
      })

    // If the root volume has not been mounted
    } else {
      // Add the volume name
      volumes.push({
        Name: rootVolumeName
      })
    }
  }

  // For every file or folder in the volume root directory
  for (let file of ls(volumeRoot + "/*")) {
    // If it is a directory
    if (file.stat.isDirectory()) {
      // If the directory has the same name as the root volume
      if (file.name === rootVolumeName) {
        // Skip this volume, the root volume takes precedence
        log.warn('Found volume with same name as root volume: ' +
          `'${rootVolumeName}' Skipping volume, root volume takes precedence.`);
        continue
      }

      // If the volume is mounted
      if (volumeIsMounted(file.name)) {
        // Add the volume name and MountPoint
        volumes.push({
          Name: file.name,
          Mountpoint: path.join(hostVolumePath, file.name)
        })

      // If the volume is not mounted
      } else {
        // Add the volume name
        volumes.push({
          Name: file.name
        })
      }
    }
  }

  // Return the volume list
  res.json({
    Volumes: volumes
  })
});

app.post('/VolumeDriver.Capabilities', function (req, res) {
  log.debug('/VolumeDriver.Capabilities');
  res.json({
    Capabilities: {
      Scope: 'global'
    }
  })
});

//
// Shutdown sequence
//

function onSignal() {
  log.info('Termination signal detected, shutting down');

  // For each volume
  for (let volumeName in mountedVolumes) {
    // If the volume is mounted
    if (volumeIsMounted(volumeName)) {
      try {
        log.debug(`Unmounting volume: ${volumeName}`);

        // Unmount the volume
        execFileSync('umount', [path.join(containerVolumePath, volumeName)]);

      } catch (err) {
        // Failure
        log.warn(`Couldn't unmount volume: ${volumeName}: ${err.toString()}`);
      }
    }
  }

  // Unmount volume root
  if (hasMountedVolumeRoot) {
    try {
      log.debug(`Unmounting volume root: ${volumeRoot}`);

      // Unmount volume root
      execFileSync('umount', [volumeRoot]);

    } catch (err) {
      // Failure
      log.warn(`Couldn't unmount volume root '${volumeRoot}': ${err.toString()}`);
    }
  }
}

//
// Start Server
//

log.info(`Starting plugin API server at ${bindAddress}`);

// Start webserver using terminus for lifecycle management
terminus(http.createServer(app), {
  logger: log.error,
  onSignal,
  onShutdown: () => {
    log.info("Server shutdown complete")
  }
}).listen(bindAddress);
