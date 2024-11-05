const mediaFiles = [
    { src: "/static/images/media2.gif", type: "gif", duration: 10000, focus: "top", hideTemps: false, zoom: 100, loop: 0 },
    { src: "/static/images/card.gif", type: "gif", duration: 10000, focus: "50% 10%", zoom: 220, hideTemps:true },
    { src: "/static/images/drunk1.gif", type: "gif", duration: 10000, focus: "top", zoom: 100},
    { src: "/static/images/umbreon.gif", type: "gif", duration: 10000, focus: "50% 10%", zoom: 130, hideTemps:true },
    { src: "/static/images/toga.gif", type: "gif", duration: 10000, focus: "top", zoom: 100},
    { src: "/static/images/media3.mp4", type: "video", focus: "center", zoom: 150},  // duration auto-calculated
    { src: "/static/images/drunk2.gif", type: "gif", duration: 10000, focus: "top", zoom: 100, hideTemps:true },
];

//PARAMETERS ARE: duration: 1000 = 1 sec, not usable in videos, focus: (list below), hideTemps: boolean (hides or shows temps info, defaults on false), zoom: (int, 100 has no change, is percentage), loop: (int, how many times it loops, additional to timer counter, works on all)


const searchParams = new URLSearchParams(window.location.search);
const kraken = searchParams.get("kraken");

let currentMediaIndex = 0;
let mediaContainer = document.querySelector(".media-container");
let mediaElement = document.createElement("img");
mediaContainer.appendChild(mediaElement);

let currentLoopCount = 0; // Keep track of how many times the current media has played

function setFocusPosition(focus) {
    switch (focus) {
        case "top":
            mediaElement.style.objectPosition = "top";
            break;
        case "center":
            mediaElement.style.objectPosition = "center";
            break;
        case "bottom":
            mediaElement.style.objectPosition = "bottom";
            break;
        case "left":
            mediaElement.style.objectPosition = "left";
            break;
        case "right":
            mediaElement.style.objectPosition = "right";
            break;
        case "top-left":
            mediaElement.style.objectPosition = "top left";
            break;
        case "top-right":
            mediaElement.style.objectPosition = "top right";
            break;
        case "bottom-left":
            mediaElement.style.objectPosition = "bottom left";
            break;
        case "bottom-right":
            mediaElement.style.objectPosition = "bottom right";
            break;
        case "20% 50%":
            mediaElement.style.objectPosition = "20% 50%"; // Custom positioning
            break;
        case "50% 10%":
            mediaElement.style.objectPosition = "50% 10%"; // Custom positioning
            break;
        default:
            mediaElement.style.objectPosition = "center"; // Fallback option
    }
}

function applyZoom(zoom) {
    if (zoom) {
        const zoomFactor = zoom / 100; // Convert percentage to a factor
        mediaElement.style.transform = `scale(${zoomFactor})`; // Scale the media element
        mediaElement.style.transformOrigin = mediaElement.style.objectPosition; // Set the transform origin to the focus point
    }
}

function toggleTemperatureOverlay(isVisible) {
    const tempOverlay = document.querySelector(".temp-overlay");
    tempOverlay.style.display = isVisible ? "block" : "none"; // Hide or show the entire overlay
}

function playMedia() {
    const media = mediaFiles[currentMediaIndex];
    const isVideo = media.type === "video"; // Check type instead of file extension

    // Remove the current media element and create a new one based on media type
    mediaElement.remove();
    if (isVideo) {
        mediaElement = document.createElement("video");
        mediaElement.src = media.src;
        mediaElement.autoplay = true;
        mediaElement.loop = false; // Set to false to control looping manually
        mediaElement.onended = () => {
            currentLoopCount++;
            if (currentLoopCount < (media.loop || 1)) {
                playMedia(); // Loop based on the loop parameter
            } else {
                cycleMedia(); // Move to the next media if loop count is reached
            }
        };
    } else {
        mediaElement = document.createElement("img");
        mediaElement.src = media.src;
        setTimeout(() => {
            currentLoopCount++;
            if (currentLoopCount < (media.loop || 1)) {
                playMedia(); // Loop based on the loop parameter
            } else {
                cycleMedia(); // Move to the next media if loop count is reached
            }
        }, media.duration || 10000);
    }

    setFocusPosition(media.focus || "center");
    applyZoom(media.zoom || 100); // Apply zoom if specified
    mediaContainer.appendChild(mediaElement);

    // Toggle temperature overlay visibility based on the hideTemps parameter
    toggleTemperatureOverlay(!media.hideTemps);
}


function cycleMedia() {
    currentMediaIndex = (currentMediaIndex + 1) % mediaFiles.length; // Loop back to the first media after the last
    currentLoopCount = 0; // Reset loop count for the next media
    playMedia();
}

function updateTemperature(cpuTemp, gpuTemp) {
    document.getElementById("cpu-temperature").innerText = `CPU: ${cpuTemp} °C`;
    document.getElementById("gpu-temperature").innerText = `GPU: ${gpuTemp} °C`;
}

if (kraken) {
    // In Kraken Browser
    window.nzxt = {
        v1: {
            onMonitoringDataUpdate: (data) => {
                const { cpus, gpus } = data;

                // Extract CPU and GPU temperatures
                const cpuTemperature = cpus.length > 0 ? Math.round(Math.abs(cpus[0].temperature)) : 'N/A';
                const gpuTemperature = gpus.length > 0 ? Math.round(Math.abs(gpus[0].temperature)) : 'N/A';

                // Update temperature readings on the webpage
                document.getElementById('cpu-temperature').innerText = `${cpuTemperature}°`;
                document.getElementById('gpu-temperature').innerText = `${gpuTemperature}°`;
            }
        }
    };

    // Call to initialize media playback
    playMedia();
} else {
    // In Configuration Browser
    window.localStorage.setItem("greeting", "Hello from Configuration Browser");
    console.log("Configuration Browser: Set greeting");
}