const Requests = require("../db/requests");
const Task = require("../db/task");
const AcceptedTasks = require("../db/acceptedTasks");
const Notifications = require("../db/notification");
const mongoose = require("mongoose");
const STATUS = {
    PENDING: "pending",
    ACCEPTED: "accepted",
    REJECTED: "rejected"
};

async function createRequest(model, taskId, requesterId, requesterName) {
    try {
        const task = await Task.findById(taskId);
        if (!task)
            return { status: 404, message: "Task not found" };

        if (task.status !== "open")
            return { status: 400, message: "Task is not available for requests" };

        if (task.user_id.toString() === requesterId.toString())
            return { status: 403, message: "You cannot send a request for your own task" };

        const newRequest = new Requests({
            task_id: taskId,
            requester_id: requesterId,
            description: model.description,
            status: STATUS.PENDING
        });
        await newRequest.save();

        try {
            const notification = new Notifications({
                user_id: task.user_id,
                message: `New request received for your task "${task.title}" from ${requesterName}.`
            });
            await notification.save();
        } catch (err) {
            console.error("Error sending notification:", err);
        }
        return { status: 201, message: "Request sent successfully", requestId: newRequest._id };
    } catch (err) {
        console.error("Error creating request:", err);
        return { status: 500, message: "Failed to save the request" };
    }
};

async function getReceivedRequests(userId) {
    try {
        const tasks = await Task.find({ user_id: userId }).select("_id");

        if (!tasks.length) {
            return { status: 200, data: [] };
        }

        const taskIds = tasks.map(t => t._id);

        const requests = await Requests.find({
            task_id: { $in: taskIds }
        })
            .populate("requester_id", "first_name last_name profile_picture")
            .populate("task_id", "title location")
            .sort({ createdAt: -1 })
            .lean();

        const response = requests.map(r => {
            const requester = r.requester_id;

            // Safe name construction
            const firstName = requester?.first_name || "Unknown";
            const lastName = requester?.last_name || "";
            const fullName = [firstName, lastName].filter(Boolean).join(" ");

            return {
                requestId: r._id,
                taskTitle: r.task_id?.title || "Untitled Task",
                taskLocation: r.task_id?.location || "Unknown Location",
                creationDate: r.createdAt,
                requester: {
                    name: fullName,
                    first_name: firstName,
                    last_name: lastName,
                    profilePicture: requester?.profile_picture || null
                },
                status: r.status,
                description: r.description
            };
        });

        return { status: 200, data: response };
    } catch (err) {
        console.error("Get received requests error:", err);
        return { status: 500, data: [] };
    }
}

async function getSentRequests(userId) {
    try {
        const requests = await Requests.find({ requester_id: userId })
            .populate({
                path: "task_id",
                populate: { path: "user_id" }
            })
            .sort({ createdAt: -1 })
            .lean();

        const response = requests.map(r => {
            const task = r.task_id;

            if (!task || typeof task !== 'object') {
                return {
                    requestId: r._id,
                    taskTitle: "Task Unavailable",
                    taskOwnerName: "Not available",
                    status: r.status,
                    creationDate: r.createdAt,
                    description: r.description,
                    taskLocation: "Unknown Location",
                    taskPicture: null
                };
            }

            const owner = task.user_id;
            const generatedName = owner
                ? [owner.first_name, owner.last_name].filter(Boolean).join(" ")
                : "Unknown Owner";

            return {
                taskId: task._id,
                taskPicture: task.picture || null,
                requestId: r._id,
                taskTitle: task.title || "Untitled Task",
                taskStatus: task.status,
                taskLocation: task.location || "Unknown Location",
                taskOwnerName: generatedName || "Unknown Owner",
                status: r.status,
                creationDate: r.createdAt,
                description: r.description
            };
        });

        return { status: 200, data: response };
    } catch (err) {
        console.error("Get sent requests error:", err);
        return { status: 500, data: [] };
    }
}

async function updateRequestStatus(requestId, action, loggedInUserId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        if (!mongoose.Types.ObjectId.isValid(requestId)) {
            return res.status(400).json({ message: "Invalid request ID format" });
        }

        const request = await Requests.findOneAndUpdate(
            { _id: requestId, status: STATUS.PENDING },
            {},
            { new: true, session }
        ).populate("task_id", "user_id title");

        if (!request) {
            await session.abortTransaction();
            return { status: 400, message: "Request already processed or not found" };
        }

        if (request.task_id.user_id.toString() !== loggedInUserId.toString()) {
            await session.abortTransaction();
            return { status: 403, message: "Not authorized" };
        }

        if (action === STATUS.REJECTED) {
            request.status = STATUS.REJECTED;
            request.rejectedAt = new Date();
            await request.save({ session });

            await Notifications.create([{
                user_id: request.requester_id,
                message: `Your request for "${request.task_id.title}" was rejected.`
            }], { session });
            await session.commitTransaction();
            return { status: 200, message: "Request rejected successfully" };
        }

        request.status = STATUS.ACCEPTED;
        await request.save({ session });

        await AcceptedTasks.create([{
            task_id: request.task_id._id,
            user_id: request.requester_id,
            status: STATUS.ACCEPTED
        }], { session });

        const otherRequests = await Requests.find({
            task_id: request.task_id._id,
            _id: { $ne: requestId },
            status: STATUS.PENDING
        }).select("requester_id").session(session);

        await Requests.updateMany(
            {
                task_id: request.task_id._id,
                _id: { $ne: requestId },
                status: STATUS.PENDING
            },
            { status: STATUS.REJECTED },
            { session }
        );

        const notifications = otherRequests.map(r => ({
            user_id: r.requester_id,
            message: `Your request for "${request.task_id.title}" was rejected because the task was assigned to someone else.`
        }));

        if (notifications.length) {
            await Notifications.insertMany(notifications, { session });
        }

        await Task.findByIdAndUpdate(request.task_id._id,
            { status: "assigned" },
            { session }
        );

        await Notifications.create([{
            user_id: request.requester_id,
            message: `Your request for "${request.task_id.title}" was accepted!`
        }], { session });

        await session.commitTransaction();
        return { status: 200, message: "Request accepted successfully" };
    } catch (err) {
        await session.abortTransaction();
        console.error("Update request status error:", err);
        return { status: 500, message: "Failed to update request" };
    } finally {
        session.endSession();
    }
}

module.exports = {
    createRequest,
    getReceivedRequests,
    updateRequestStatus,
    getSentRequests,
};