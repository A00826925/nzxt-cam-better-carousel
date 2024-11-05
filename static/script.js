
/*
const mediaFiles = [
    { src: "/static/images/media2.gif", type: "gif", duration: 10000, focus: "top", hideTemps: false, zoom: 100, loop: 0 },
    { src: "/static/images/card.gif", type: "gif", duration: 10000, focus: "50% 10%", zoom: 220, hideTemps:true },
    { src: "/static/images/drunk1.gif", type: "gif", duration: 10000, focus: "top", zoom: 100},
    { src: "/static/images/umbreon.gif", type: "gif", duration: 10000, focus: "50% 10%", zoom: 130, hideTemps:true },
    { src: "/static/images/toga.gif", type: "gif", duration: 10000, focus: "top", zoom: 100},
    { src: "/static/images/media3.mp4", type: "video", focus: "center", zoom: 150},  // duration auto-calculated
    { src: "/static/images/drunk2.gif", type: "gif", duration: 10000, focus: "top", zoom: 100, hideTemps:true },
];
*/

const mediaFiles = [
    { src: "/static/images/umbreon.gif", type: "gif", duration: 10000, focus: "50% 10%", zoom: 130, overlayStyle: "clock" },

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
    const isVideo = media.type === "video";

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

    // Update overlay display based on overlayStyle
    updateOverlayDisplay(media.overlayStyle || "none");
}

function createHourMarkers() {
    const hourMarkersContainer = document.querySelector('.hour-markers');
    hourMarkersContainer.innerHTML = ''; // Clear existing markers
    const totalHours = 12; // Total hours on a clock
    const radius = 140; // Decrease this value to move the markers closer to the center

    for (let i = 0; i < totalHours; i++) {
        const marker = document.createElement('div');
        marker.className = 'hour-marker';

        // Calculate the position of the marker
        const angle = (i * 30) * (Math.PI / 180); // 30 degrees for each hour
        const x = radius * Math.cos(angle) + 320; // 320 is half of your clock's width (640/2)
        const y = radius * Math.sin(angle) + 320; // 320 is half of your clock's height (640/2)

        marker.style.left = `${x}px`;
        marker.style.top = `${y}px`;

        hourMarkersContainer.appendChild(marker);
    }
}


function startClock() {
    const hourHand = document.querySelector(".hour-hand");
    const minuteHand = document.querySelector(".minute-hand");
    const secondHand = document.querySelector(".second-hand");

    function updateClock() {
        const now = new Date(); // Get the current date and time
        const seconds = now.getSeconds();
        const minutes = now.getMinutes();
        const hours = now.getHours() % 12; // Convert to 12-hour format
    
        // Calculate the rotation of each hand based on the current time
        const secondDeg = ((seconds / 60) * 360) + 90 + 180; // Adding 180 to flip it
        const minuteDeg = ((minutes / 60) * 360) + ((seconds / 60) * 6) + 90 + 180; // Add a bit for the seconds and flip
        const hourDeg = ((hours / 12) * 360) + ((minutes / 60) * 30) + 90 + 180; // Add a bit for the minutes and flip
    
        // Set the rotation of each hand
        document.querySelector('.second-hand').style.transform = `rotate(${secondDeg}deg)`;
        document.querySelector('.minute-hand').style.transform = `rotate(${minuteDeg}deg)`;
        document.querySelector('.hour-hand').style.transform = `rotate(${hourDeg}deg)`;
    }
    
    // Update the clock every second
    setInterval(updateClock, 1000);
    
    // Initial call to set the clock hands at page load
    createHourMarkers();
    updateClock();    
}

function updateOverlayDisplay(style) {
    const tempOverlay = document.querySelector(".temp-overlay");
    const watchface1Overlay = document.querySelector(".watchface-1-overlay");

    // Hide all overlays initially
    tempOverlay.style.display = "none";
    watchface1Overlay.style.display = "none";

    // Show overlay based on specified style
    if (style === "dualTemps") {
        tempOverlay.style.display = "flex"; // Display the main temperature overlay
    } else if (style === "clock") {
        watchface1Overlay.style.display = "flex"; // Display alternative overlay
        startClock();
    }
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

if (true) {
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